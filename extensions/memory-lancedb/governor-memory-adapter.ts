import type {
  MemoryGovernorBackend,
  MemoryGovernorFact,
  MemoryGovernorRecall,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { GovernorMemoryLedger } from "./governor-memory-ledger.js";
import type { HybridMemoryIndex } from "./hybrid-memory-index.js";
import type { DurableMemoryEmbedding } from "./memory-embedding.js";

export type GovernorMemoryLanceDbAdapterOptions = {
  ledgerPath: string;
  index: HybridMemoryIndex;
  embeddings: DurableMemoryEmbedding;
  refreshDerived?: () => Promise<void>;
  observeOnly?: boolean;
  enqueueProjection?: boolean;
};

function boundedLimit(value: number): number {
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function resultFact(fact: MemoryGovernorFact): MemoryGovernorRecall {
  return {
    memoryId: fact.memoryId,
    agentId: fact.agentId,
    scope: fact.scope,
    factKey: fact.factKey,
    text: fact.text,
    confidence: fact.confidence,
    authority: fact.authority,
    observedAt: fact.observedAt,
    sourceEvidenceDigest: fact.sourceEvidenceDigest,
  };
}

/**
 * Governor adapter for the installed LanceDB backend. SQLite fact revisions
 * are authoritative; LanceDB, embeddings, summaries, and FTS are projections.
 * Recall therefore validates every projected hit against the ledger before it
 * can be returned, including during projection lag or after a restart.
 */
export class GovernorMemoryLanceDbAdapter implements MemoryGovernorBackend {
  readonly #ledger: GovernorMemoryLedger;
  readonly #index: HybridMemoryIndex;
  readonly #embeddings: DurableMemoryEmbedding;
  readonly #refreshDerived?: () => Promise<void>;
  readonly #observeOnly: boolean;
  #closed = false;

  constructor(options: GovernorMemoryLanceDbAdapterOptions) {
    this.#ledger = new GovernorMemoryLedger(options.ledgerPath, {
      enqueueProjection: options.enqueueProjection,
    });
    this.#index = options.index;
    this.#embeddings = options.embeddings;
    this.#refreshDerived = options.refreshDerived;
    this.#observeOnly = options.observeOnly === true;
  }

  async admit(params: Parameters<MemoryGovernorBackend["admit"]>[0]) {
    this.assertOpen();
    if (this.#observeOnly) {
      return { status: "rejected" as const, reason: "shadow_observation_only" };
    }
    const result = this.#ledger.admit(params.fact, params.now);
    if (result.status === "admitted" && result.fact) {
      await this.#project(result.fact, result.staleRevisionId);
    }
    return result.status === "rejected"
      ? { status: result.status, reason: result.reason ?? "rejected" }
      : {
          status: result.status,
          fact: result.fact!,
          remediationId: result.remediationId,
        };
  }

  async recall(
    params: Parameters<MemoryGovernorBackend["recall"]>[0],
  ): Promise<readonly MemoryGovernorRecall[]> {
    this.assertOpen();
    if (this.#observeOnly || params.scopes.length === 0) {
      return [];
    }
    const vector = await this.#embeddings.embed(params.query);
    const hits = (
      await Promise.all(
        params.scopes.map((scope) =>
          this.#index.search({
            queryText: params.query,
            vector,
            agentId: params.agentId,
            scope,
            limit: boundedLimit(params.limit),
            recordTypes: ["fact"],
            validAt: params.now,
          }),
        ),
      )
    ).flat();
    const current = this.#ledger.listCurrent(params.agentId, params.scopes, params.now);
    const byRevision = new Map(current.map((fact) => [fact.memoryId, fact]));
    return hits
      .map((hit) => byRevision.get(hit.entry.id))
      .filter((fact): fact is MemoryGovernorFact => Boolean(fact))
      .toSorted(
        (left, right) =>
          right.authority - left.authority ||
          right.confidence - left.confidence ||
          right.observedAt - left.observedAt,
      )
      .slice(0, boundedLimit(params.limit))
      .map(resultFact);
  }

  async invalidate(params: Parameters<MemoryGovernorBackend["invalidate"]>[0]) {
    this.assertOpen();
    if (this.#observeOnly) {
      throw new Error("GOVERNOR_MEMORY_SHADOW_MUTATION");
    }
    const result = this.#ledger.invalidate(params);
    if (result.invalidatedMemoryIds.length === 1) {
      await this.#index.delete(result.staleMemoryId);
    } else {
      for (const memoryId of result.invalidatedMemoryIds) {
        await this.#index.delete(memoryId);
      }
    }
    if (result.replacementMemoryId && result.replacementFact) {
      await this.#project(result.replacementFact);
    }
    await this.#refreshDerived?.();
    return result;
  }

  async compact(params: Parameters<MemoryGovernorBackend["compact"]>[0]) {
    this.assertOpen();
    if (this.#observeOnly) {
      return { compacted: 0, retainedHighWater: 0 };
    }
    const result = this.#ledger.compact(params);
    for (const memoryId of result.compactedMemoryIds) {
      await this.#index.delete(memoryId);
    }
    await this.#index.optimizeIfNeeded(1);
    return result;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#ledger.close();
  }

  async #project(fact: MemoryGovernorFact, staleRevisionId?: string): Promise<void> {
    if (staleRevisionId) {
      await this.#index.delete(staleRevisionId);
    }
    const vector = await this.#embeddings.embed(fact.text);
    await this.#index.upsertBatch([
      {
        id: fact.memoryId,
        recordType: "fact",
        text: fact.text,
        vector,
        agentId: fact.agentId,
        scope: fact.scope,
        factKey: fact.factKey,
        category: fact.category ?? "fact",
        status: "active",
        importance: Math.max(fact.authority, fact.confidence),
        confidence: fact.confidence,
        authority: fact.authority,
        validFrom: fact.observedAt,
        validTo: fact.freshnessExpiresAt,
        observedAt: fact.observedAt,
        sourceEventId: fact.sourceEvidenceId,
        tags: ["governor", "verified", fact.predicate],
        updatedAt: fact.observedAt,
      },
    ]);
    await this.#refreshDerived?.();
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error("GOVERNOR_MEMORY_BACKEND_CLOSED");
    }
  }
}

export function createShadowGovernorMemoryBackend(): MemoryGovernorBackend {
  return Object.freeze({
    admit: async () => ({ status: "rejected" as const, reason: "shadow_observation_only" }),
    recall: async () => [],
    invalidate: async () => {
      throw new Error("GOVERNOR_MEMORY_SHADOW_MUTATION");
    },
    compact: async () => ({ compacted: 0, retainedHighWater: 0, compactedMemoryIds: [] }),
    close: () => undefined,
  });
}
