import { authenticateGovernorMemoryFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemoryGovernorBackend,
  MemoryGovernorFact,
  MemoryGovernorRecall,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { GovernorMemoryLedger } from "./governor-memory-ledger.js";
import type { HybridMemoryIndex } from "./hybrid-memory-index.js";
import type { DurableMemoryEmbedding } from "./memory-embedding.js";

const GOVERNOR_LEDGER_OWNER = "governor-memory";

export type GovernorMemoryLanceDbAdapterOptions = {
  ledgerPath: string;
  ledger?: GovernorMemoryLedger;
  ownsLedger?: boolean;
  index: HybridMemoryIndex;
  embeddings: DurableMemoryEmbedding;
  refreshDerived?: () => Promise<void>;
  observeOnly?: boolean;
  enqueueProjection?: boolean;
  authorityBindingKey?: string;
};

function boundedLimit(value: number): number {
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function resultFact(fact: MemoryGovernorFact): MemoryGovernorRecall {
  return {
    memoryId: fact.memoryId,
    agentId: fact.agentId,
    scope: fact.scope,
    scopeKey: fact.scopeKey,
    factKey: fact.factKey,
    text: fact.text,
    confidence: fact.confidence,
    authority: fact.authority,
    observedAt: fact.observedAt,
    sourceEvidenceDigest: fact.sourceEvidenceDigest,
    contentDigest: fact.contentDigest,
    authorityBindingDigest: fact.authorityBindingDigest,
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
  readonly #ownsLedger: boolean;
  readonly #authorityBindingKey?: string;
  #closed = false;

  constructor(options: GovernorMemoryLanceDbAdapterOptions) {
    this.#ledger =
      options.ledger ??
      new GovernorMemoryLedger(options.ledgerPath, {
        enqueueProjection: options.enqueueProjection,
        authorityBindingKey: options.authorityBindingKey,
      });
    this.#index = options.index;
    this.#embeddings = options.embeddings;
    this.#refreshDerived = options.refreshDerived;
    this.#observeOnly = options.observeOnly === true;
    this.#ownsLedger = options.ownsLedger ?? options.ledger === undefined;
    this.#authorityBindingKey = options.authorityBindingKey;
  }

  async admit(params: Parameters<MemoryGovernorBackend["admit"]>[0]) {
    this.assertOpen();
    await this.#replayPending(params.now);
    if (this.#observeOnly) {
      return { status: "rejected" as const, reason: "shadow_observation_only" };
    }
    const fact = this.#authorityBindingKey
      ? authenticateGovernorMemoryFact(params.fact, this.#authorityBindingKey)
      : params.fact;
    const result = this.#ledger.admit(fact, params.now);
    if ((result.status === "admitted" || result.status === "duplicate") && result.fact) {
      await this.#project(result.fact, result.staleRevisionId);
      this.#ledger.markRemediationCompleted(result.remediationId, params.now);
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
    await this.#replayPending(params.now);
    const scopeKeys = params.scopeKeys ?? params.scopes;
    if (this.#observeOnly || scopeKeys.length === 0) {
      return [];
    }
    const vector = await this.#embeddings.embed(params.query);
    const hits = (
      await Promise.all(
        scopeKeys.map((scopeKey) =>
          this.#index.search({
            queryText: params.query,
            vector,
            agentId: GOVERNOR_LEDGER_OWNER,
            scope: scopeKey,
            limit: boundedLimit(params.limit),
            recordTypes: ["fact"],
            validAt: params.now,
          }),
        ),
      )
    ).flat();
    const current = this.#ledger.listCurrent(GOVERNOR_LEDGER_OWNER, scopeKeys, params.now);
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
    await this.#replayPending(params.now);
    if (this.#observeOnly) {
      throw new Error("GOVERNOR_MEMORY_SHADOW_MUTATION");
    }
    const replacement =
      params.replacement && this.#authorityBindingKey
        ? authenticateGovernorMemoryFact(params.replacement, this.#authorityBindingKey)
        : params.replacement;
    const result = this.#ledger.invalidate({
      ...params,
      agentId: GOVERNOR_LEDGER_OWNER,
      scopeKey: params.scopeKey ?? params.scope,
      ...(replacement ? { replacement } : {}),
    });
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
    this.#ledger.markRemediationCompleted(result.remediationId, params.now);
    return result;
  }

  async retire(params: {
    agentId: string;
    scope: string;
    scopeKey?: string;
    factKey: string;
    staleMemoryId: string;
    reason: "freshness_expired" | "operator_requested";
    now: number;
  }) {
    this.assertOpen();
    await this.#replayPending(params.now);
    if (this.#observeOnly) {
      throw new Error("GOVERNOR_MEMORY_SHADOW_MUTATION");
    }
    const result = this.#ledger.retire({
      agentId: GOVERNOR_LEDGER_OWNER,
      scopeKey: params.scopeKey ?? params.scope,
      factKey: params.factKey,
      staleMemoryId: params.staleMemoryId,
      reason: params.reason,
      now: params.now,
    });
    if (result.status === "retired") {
      await this.#index.delete(result.staleMemoryId);
      await this.#refreshDerived?.();
      this.#ledger.markRemediationCompleted(result.remediationId, params.now);
    }
    return result;
  }

  async compact(params: Parameters<MemoryGovernorBackend["compact"]>[0]) {
    this.assertOpen();
    await this.#replayPending(params.now);
    if (this.#observeOnly) {
      return { compacted: 0, retainedHighWater: 0 };
    }
    const result = this.#ledger.compact({ ...params, agentId: GOVERNOR_LEDGER_OWNER });
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
    if (this.#ownsLedger) {
      this.#ledger.close();
    }
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
        agentId: GOVERNOR_LEDGER_OWNER,
        scope: fact.scopeKey,
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

  async #replayPending(now: number): Promise<void> {
    for (const remediation of this.#ledger.pendingRemediations()) {
      if (remediation.replacementFact) {
        await this.#project(remediation.replacementFact, remediation.staleRevisionId);
      } else {
        await this.#index.delete(remediation.staleRevisionId);
      }
      this.#ledger.markRemediationCompleted(remediation.remediationId, now);
    }
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
