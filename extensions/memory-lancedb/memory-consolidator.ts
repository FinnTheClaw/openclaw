import { randomUUID } from "node:crypto";
import type { DurableMemoryEmbedding, DurableMemoryLogger } from "./durable-memory-runtime.js";
import type { HybridMemoryIndex, MemoryProjectionInput } from "./hybrid-memory-index.js";
import {
  TemporalMemoryLedger,
  type FactExtractionLease,
  type MaterializationLease,
  type StoredFactRevision,
  type StoredSummaryNode,
} from "./temporal-ledger.js";

const DEFAULT_EXTRACTION_BATCH = 8;
const DEFAULT_SUMMARY_BATCH = 4;
const DEFAULT_MATERIALIZATION_BATCH = 32;
const DEFAULT_LEASE_MS = 120_000;
const MAX_PASSES_PER_TICK = 4;

export type ExtractedMemoryFact = {
  factKey?: string;
  scope?: string;
  subject: string;
  predicate: string;
  object: string;
  text: string;
  category?: string;
  confidence?: number;
  authority?: number;
  validFrom?: number;
  validTo?: number;
  metadata?: Record<string, unknown>;
};

export type MemoryFactExtractor = {
  readonly version: string;
  extract(event: FactExtractionLease): Promise<ExtractedMemoryFact[]>;
};

export type MemorySummarizer = {
  readonly version: string;
  summarize(node: StoredSummaryNode, sources: string[]): Promise<string>;
};

export type MemoryConsolidatorOptions = {
  ledger: TemporalMemoryLedger;
  index: HybridMemoryIndex;
  embeddings: DurableMemoryEmbedding;
  logger: DurableMemoryLogger;
  extractor?: MemoryFactExtractor;
  summarizer?: MemorySummarizer;
  extractionBatch?: number;
  extractionConcurrency?: number;
  summaryBatch?: number;
  summaryConcurrency?: number;
  materializationBatch?: number;
  embeddingTimeoutMs?: number;
};

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(value ?? fallback)));
}

function boundedUnit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`extracted memory ${label} must not be empty`);
  }
  return normalized.slice(0, maxLength);
}

function normalizeExtractedFact(fact: ExtractedMemoryFact): ExtractedMemoryFact {
  return {
    ...(fact.factKey ? { factKey: boundedText(fact.factKey, "factKey", 256) } : {}),
    ...(fact.scope ? { scope: boundedText(fact.scope, "scope", 128) } : {}),
    subject: boundedText(fact.subject, "subject", 256),
    predicate: boundedText(fact.predicate, "predicate", 128),
    object: boundedText(fact.object, "object", 2_000),
    text: boundedText(fact.text, "text", 4_000),
    category: fact.category ? boundedText(fact.category, "category", 64) : "fact",
    confidence: boundedUnit(fact.confidence, 0.8),
    authority: boundedUnit(fact.authority, 0.5),
    ...(fact.validFrom === undefined ? {} : { validFrom: Math.floor(fact.validFrom) }),
    ...(fact.validTo === undefined ? {} : { validTo: Math.floor(fact.validTo) }),
    metadata: fact.metadata ?? {},
  };
}

function isIdentityOrAccessFact(fact: ExtractedMemoryFact): boolean {
  return /\b(identity|phone|sender|contact|admin|administrator|owner|ownership|access|authoriz|permission|credential|pairing)\b/iu.test(
    `${fact.category ?? ""} ${fact.subject} ${fact.predicate} ${fact.text}`,
  );
}

function extractionScopeForEvent(
  event: FactExtractionLease,
  fact: ExtractedMemoryFact,
): { scope: string; sensitivity: "identity_access" | "ordinary" } | undefined {
  const conversationScope =
    typeof event.metadata.memoryScope === "string" ? event.metadata.memoryScope : "global";
  const principalScope =
    typeof event.metadata.principalScope === "string"
      ? event.metadata.principalScope
      : conversationScope;
  if (isIdentityOrAccessFact(fact)) {
    // Historical prose is never authorization evidence. Identity/access facts
    // require a current structured verifier to stamp the source event.
    if (
      event.metadata.verificationStatus !== "verified" ||
      event.metadata.evidenceClass !== "verified_operator" ||
      event.sourceKind !== "structured_identity_inventory" ||
      typeof event.sourceRef !== "string" ||
      !event.sourceRef.startsWith("evidence_")
    ) {
      return undefined;
    }
    return { scope: principalScope, sensitivity: "identity_access" };
  }
  return { scope: principalScope, sensitivity: "ordinary" };
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) {
        return;
      }
      await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, () => worker()),
  );
}

function factProjection(fact: StoredFactRevision, vector: number[]): MemoryProjectionInput {
  return {
    id: fact.revisionId,
    recordType: "fact",
    text: fact.text,
    vector,
    agentId: fact.agentId,
    scope: fact.scope,
    factKey: fact.factKey,
    category: fact.category,
    status: fact.status,
    importance: Math.max(fact.authority, fact.confidence),
    confidence: fact.confidence,
    authority: fact.authority,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    observedAt: fact.observedAt,
    sourceEventId: fact.sourceEventId,
    tags: ["fact", fact.subject, fact.predicate],
    updatedAt: fact.systemTo ?? fact.systemFrom,
  };
}

function summaryProjection(summary: StoredSummaryNode, vector: number[]): MemoryProjectionInput {
  const importance =
    summary.level === "day"
      ? 0.68
      : summary.level === "week"
        ? 0.72
        : summary.level === "month"
          ? 0.76
          : 0.8;
  return {
    id: summary.nodeId,
    recordType: "summary",
    text: summary.summaryText,
    vector,
    agentId: summary.agentId,
    scope: summary.scope,
    category: `summary:${summary.level}`,
    status: "active",
    importance,
    confidence: 0.8,
    authority: 0.75,
    validFrom: summary.bucketStart,
    observedAt: summary.bucketEnd - 1,
    sourceEventId: "",
    tags: ["summary", summary.level],
    updatedAt: summary.updatedAt,
  };
}

/**
 * Asynchronous semantic maintenance. Raw capture remains durable even if every
 * model is down; leases make extraction, summaries, and index updates replayable.
 */
export class MemoryConsolidator {
  private readonly workerId = `memory-consolidator-${process.pid}-${randomUUID()}`;
  private readonly extractionBatch: number;
  private readonly extractionConcurrency: number;
  private readonly summaryBatch: number;
  private readonly summaryConcurrency: number;
  private readonly materializationBatch: number;
  private readonly embeddingTimeoutMs: number;
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private materializationMaintenanceCounter = 0;
  private stopped = false;

  constructor(private readonly options: MemoryConsolidatorOptions) {
    this.extractionBatch = boundedInteger(options.extractionBatch, DEFAULT_EXTRACTION_BATCH, 64);
    this.extractionConcurrency = boundedInteger(options.extractionConcurrency, 2, 8);
    this.summaryBatch = boundedInteger(options.summaryBatch, DEFAULT_SUMMARY_BATCH, 32);
    this.summaryConcurrency = boundedInteger(options.summaryConcurrency, 2, 8);
    this.materializationBatch = boundedInteger(
      options.materializationBatch,
      DEFAULT_MATERIALIZATION_BATCH,
      256,
    );
    this.embeddingTimeoutMs = boundedInteger(options.embeddingTimeoutMs, 30_000, 120_000);
  }

  schedule(): void {
    if (this.stopped) {
      return;
    }
    this.drainRequested = true;
    if (this.drainPromise) {
      return;
    }
    this.drainPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    })
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.options.logger.warn?.(`memory-v2: consolidation worker failed: ${String(error)}`);
      })
      .finally(() => {
        this.drainPromise = null;
        if (this.drainRequested && !this.stopped) {
          this.schedule();
        }
      });
  }

  async flush(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.drainRequested = true;
    while (Date.now() <= deadline) {
      if (this.drainPromise) {
        await Promise.race([
          this.drainPromise,
          new Promise<void>((resolve) => {
            setTimeout(resolve, Math.max(1, deadline - Date.now()));
          }),
        ]);
      } else {
        await this.drain();
      }
      const stats = this.options.ledger.getStats();
      const extractionDone = !this.options.extractor || stats.pendingExtraction === 0;
      const summariesDone = !this.options.summarizer || stats.dirtySummaries === 0;
      if (extractionDone && summariesDone && stats.pendingMaterialization === 0) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25, deadline - Date.now()));
      });
    }
    return false;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.drainPromise) {
      await Promise.race([
        this.drainPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        }),
      ]).catch(() => undefined);
    }
  }

  private async drain(): Promise<void> {
    this.drainRequested = false;
    for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
      const extracted = await this.drainExtraction();
      const summarized = await this.drainSummaries();
      const materialized = await this.drainMaterialization();
      if (extracted + summarized + materialized === 0) {
        return;
      }
    }
    this.drainRequested = true;
  }

  private async drainExtraction(): Promise<number> {
    if (!this.options.extractor) {
      return 0;
    }
    const extractor = this.options.extractor;
    const events = this.options.ledger.claimFactExtractionBatch({
      owner: this.workerId,
      limit: this.extractionBatch,
      leaseMs: DEFAULT_LEASE_MS,
    });
    await mapConcurrent(events, this.extractionConcurrency, async (event) => {
      try {
        const evidenceClass = event.metadata.evidenceClass ?? "direct_user";
        if (evidenceClass !== "direct_user" && evidenceClass !== "verified_operator") {
          this.options.ledger.markFactExtractionCompleted(event.eventId, this.workerId);
          return;
        }
        const extracted = await extractor.extract(event);
        if (!Array.isArray(extracted) || extracted.length > 32) {
          throw new Error("memory extractor must return an array of at most 32 facts");
        }
        for (const rawFact of extracted) {
          const fact = normalizeExtractedFact(rawFact);
          const scoped = extractionScopeForEvent(event, fact);
          if (!scoped) {
            continue;
          }
          this.options.ledger.appendFactRevision({
            ...fact,
            agentId: event.agentId,
            scope: scoped.scope,
            sourceEventId: event.eventId,
            observedAt: event.observedAt,
            validFrom: fact.validFrom ?? event.validFrom ?? event.observedAt,
            metadata: {
              ...fact.metadata,
              extractorVersion: extractor.version,
              evidenceClass,
              evidenceRef: `evidence_${event.eventId}`,
              evidenceObservedAt: event.observedAt,
              verificationStatus: event.metadata.verificationStatus ?? "observed",
              sensitivity: scoped.sensitivity,
            },
          });
        }
        this.options.ledger.markFactExtractionCompleted(event.eventId, this.workerId);
      } catch (error) {
        this.options.ledger.markFactExtractionFailed({
          eventId: event.eventId,
          owner: this.workerId,
          error,
          retryDelayMs: Math.min(900_000, 5_000 * 2 ** Math.min(event.attempts, 7)),
        });
      }
    });
    return events.length;
  }

  private async drainSummaries(): Promise<number> {
    if (!this.options.summarizer) {
      return 0;
    }
    const summarizer = this.options.summarizer;
    const nodes = this.options.ledger.claimSummaryBatch({
      owner: this.workerId,
      limit: this.summaryBatch,
      leaseMs: DEFAULT_LEASE_MS,
    });
    await mapConcurrent(nodes, this.summaryConcurrency, async (node) => {
      try {
        const sources = this.options.ledger.getSummarySources(node);
        if (sources.length === 0) {
          throw new Error(`summary node ${node.nodeId} has no durable sources`);
        }
        const summary = boundedText(await summarizer.summarize(node, sources), "summary", 12_000);
        this.options.ledger.completeSummary({
          nodeId: node.nodeId,
          owner: this.workerId,
          targetGeneration: node.targetGeneration,
          summaryText: summary,
        });
      } catch (error) {
        this.options.ledger.markSummaryFailed({
          nodeId: node.nodeId,
          owner: this.workerId,
          error,
          retryDelayMs: Math.min(3_600_000, 10_000 * 2 ** Math.min(node.attempts, 7)),
        });
      }
    });
    return nodes.length;
  }

  private async drainMaterialization(): Promise<number> {
    const leases = this.options.ledger.claimMaterializationBatch({
      owner: this.workerId,
      limit: this.materializationBatch,
      leaseMs: DEFAULT_LEASE_MS,
    });
    if (leases.length === 0) {
      return 0;
    }
    const records = leases.map((lease) => ({
      lease,
      record: this.options.ledger.getMaterializationRecord(lease),
    }));
    const present = records.filter(
      (
        entry,
      ): entry is {
        lease: MaterializationLease;
        record: StoredFactRevision | StoredSummaryNode;
      } => Boolean(entry.record),
    );
    for (const missing of records.filter((entry) => !entry.record)) {
      this.options.ledger.markMaterialized(missing.lease);
    }
    if (present.length === 0) {
      return leases.length;
    }
    try {
      const texts = present.map(({ record }) =>
        "revisionId" in record ? record.text : record.summaryText,
      );
      const vectors = this.options.embeddings.embedBatch
        ? await this.options.embeddings.embedBatch(texts, { timeoutMs: this.embeddingTimeoutMs })
        : await Promise.all(
            texts.map((text) =>
              this.options.embeddings.embed(text, { timeoutMs: this.embeddingTimeoutMs }),
            ),
          );
      if (vectors.length !== present.length) {
        throw new Error(
          `memory materialization returned ${vectors.length} vectors for ${present.length} records`,
        );
      }
      await this.options.index.upsertBatch(
        present.map(({ record }, index) =>
          "revisionId" in record
            ? factProjection(record, vectors[index]!)
            : summaryProjection(record, vectors[index]!),
        ),
      );
      for (const { lease } of present) {
        this.options.ledger.markMaterialized(lease);
      }
      this.materializationMaintenanceCounter += present.length;
      if (this.materializationMaintenanceCounter >= 256) {
        this.materializationMaintenanceCounter = 0;
        try {
          await this.options.index.ensureIndices();
          await this.options.index.optimizeIfNeeded();
        } catch (error) {
          this.options.logger.warn?.(
            `memory-v2: consolidation index maintenance deferred: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      for (const { lease } of present) {
        this.options.ledger.markMaterializationFailed({
          lease,
          error,
          retryDelayMs: Math.min(900_000, 5_000 * 2 ** Math.min(lease.attempts, 7)),
        });
      }
    }
    return leases.length;
  }
}
