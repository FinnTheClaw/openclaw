import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { HybridMemoryIndex, type MemoryProjectionInput } from "./hybrid-memory-index.js";
import {
  TemporalMemoryLedger,
  type MemoryEventInput,
  type MemoryRole,
  type ProjectionLease,
} from "./temporal-ledger.js";

const DEFAULT_PROJECTION_BATCH = 32;
const DEFAULT_PROJECTION_CONCURRENCY = 4;
const DEFAULT_PROJECTION_LEASE_MS = 120_000;
const MAX_PROJECTION_PASSES_PER_TICK = 8;

export type DurableMemoryLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type DurableMemoryEmbedding = {
  embed(text: string, options?: { timeoutMs?: number }): Promise<number[]>;
  embedBatch?(texts: string[], options?: { timeoutMs?: number }): Promise<number[][]>;
};

export type DurableMemoryRuntimeOptions = {
  ledgerPath: string;
  projectionPath: string;
  vectorDimensions: number;
  embeddings: DurableMemoryEmbedding;
  logger: DurableMemoryLogger;
  storageOptions?: Record<string, string>;
  projectionBatch?: number;
  projectionConcurrency?: number;
  embeddingTimeoutMs?: number;
};

type MessageCaptureContext = {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  conversationId?: string;
  sourceKind: string;
  sourceRef?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageRole(value: unknown): MemoryRole {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
    ? value
    : "unknown";
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    if (typeof record.text === "string") {
      parts.push(record.text);
    } else if (typeof record.content === "string") {
      parts.push(record.content);
    }
  }
  return parts.join("\n").trim();
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stableMessageExternalId(options: {
  role: MemoryRole;
  content: string;
  timestamp?: number;
  messageId?: string;
  runId?: string;
}): string | undefined {
  if (options.messageId) {
    return `message-id:${options.messageId}`;
  }
  if (options.timestamp !== undefined) {
    return `message:${options.role}:${options.timestamp}:${sha256(options.content)}`;
  }
  if (options.runId) {
    return `run:${options.runId}:${options.role}:${sha256(options.content)}`;
  }
  return undefined;
}

function resolveAgentId(explicit: string | undefined, sessionKey: string | undefined): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (sessionKey) {
    return resolveAgentIdFromSessionKey(sessionKey) ?? "main";
  }
  return "main";
}

function projectionImportance(event: ProjectionLease): number {
  switch (event.role) {
    case "user":
      return 0.85;
    case "assistant":
      return 0.65;
    case "system":
      return 0.45;
    case "tool":
      return 0.35;
    default:
      return 0.25;
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = Array.from<PromiseSettledResult<R> | undefined>({ length: values.length });
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) {
        return;
      }
      try {
        results[index] = { status: "fulfilled", value: await fn(values[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, () => worker()),
  );
  return results as Array<PromiseSettledResult<R>>;
}

/**
 * Connects synchronous durable capture to asynchronous, rebuildable indexing.
 * Capture never waits for an embedding model. Retrieval never scans the ledger.
 */
export class DurableMemoryRuntime {
  readonly ledger: TemporalMemoryLedger;
  readonly index: HybridMemoryIndex;
  private readonly workerId = `memory-worker-${process.pid}-${randomUUID()}`;
  private readonly projectionBatch: number;
  private readonly projectionConcurrency: number;
  private readonly embeddingTimeoutMs: number;
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private maintenanceCounter = 0;
  private stopped = false;

  constructor(private readonly options: DurableMemoryRuntimeOptions) {
    this.ledger = new TemporalMemoryLedger(options.ledgerPath);
    this.index = new HybridMemoryIndex(
      options.projectionPath,
      options.vectorDimensions,
      options.storageOptions,
    );
    this.projectionBatch = Math.min(
      256,
      Math.max(1, Math.floor(options.projectionBatch ?? DEFAULT_PROJECTION_BATCH)),
    );
    this.projectionConcurrency = Math.min(
      16,
      Math.max(1, Math.floor(options.projectionConcurrency ?? DEFAULT_PROJECTION_CONCURRENCY)),
    );
    this.embeddingTimeoutMs = Math.max(1_000, Math.floor(options.embeddingTimeoutMs ?? 15_000));
  }

  captureInbound(options: {
    agentId?: string;
    sessionKey?: string;
    channel?: string;
    conversationId?: string;
    content: string;
    timestamp?: number;
    messageId?: string;
    runId?: string;
    from?: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    const content = options.content.trim();
    if (!content) {
      return false;
    }
    const agentId = resolveAgentId(options.agentId, options.sessionKey);
    const result = this.ledger.appendEvent({
      agentId,
      sessionKey: options.sessionKey,
      channel: options.channel,
      conversationId: options.conversationId,
      role: "user",
      content,
      sourceKind: "message_received",
      sourceRef: options.from,
      observedAt: options.timestamp,
      externalId: stableMessageExternalId({
        role: "user",
        content,
        timestamp: options.timestamp,
        messageId: options.messageId,
        runId: options.runId,
      }),
      metadata: options.metadata,
    });
    if (result.inserted) {
      this.scheduleProjection();
    }
    return result.inserted;
  }

  captureMessage(message: unknown, context: MessageCaptureContext): boolean {
    const record = asRecord(message);
    if (!record) {
      return false;
    }
    const role = messageRole(record.role);
    const content = extractText(record.content);
    if (!content) {
      return false;
    }
    const observedAt = timestampMs(record.timestamp);
    const messageId = typeof record.id === "string" ? record.id : undefined;
    const agentId = resolveAgentId(context.agentId, context.sessionKey);
    const result = this.ledger.appendEvent({
      agentId,
      sessionKey: context.sessionKey,
      channel: context.channel,
      conversationId: context.conversationId,
      role,
      content,
      sourceKind: context.sourceKind,
      sourceRef: context.sourceRef,
      observedAt,
      externalId: stableMessageExternalId({ role, content, timestamp: observedAt, messageId }),
      metadata: { messageType: typeof record.type === "string" ? record.type : undefined },
    });
    if (result.inserted) {
      this.scheduleProjection();
    }
    return result.inserted;
  }

  captureManualMemory(options: {
    agentId: string;
    text: string;
    category?: string;
    importance?: number;
    externalId?: string;
    observedAt?: number;
    metadata?: Record<string, unknown>;
  }): { id: string; inserted: boolean } {
    const result = this.ledger.appendEvent({
      agentId: options.agentId,
      role: "user",
      content: options.text,
      sourceKind: "manual_memory",
      externalId: options.externalId,
      observedAt: options.observedAt,
      metadata: {
        ...options.metadata,
        category: options.category ?? "other",
        importance: options.importance ?? 0.7,
        confidence: 1,
        authority: 1,
      },
    });
    if (result.inserted) {
      this.scheduleProjection();
    }
    return { id: result.event.eventId, inserted: result.inserted };
  }

  captureMessages(messages: unknown[], context: MessageCaptureContext): number {
    let captured = 0;
    for (const message of messages) {
      if (this.captureMessage(message, context)) {
        captured++;
      }
    }
    return captured;
  }

  async reconcileTranscript(options: {
    file: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<{ lines: number; captured: number; reset: boolean }> {
    const fileStat = await stat(options.file);
    const identity = `${String(fileStat.dev)}:${String(fileStat.ino)}`;
    const prior = this.ledger.getIngestCursor(options.file);
    const reset = !prior || prior.sourceIdentity !== identity || prior.byteOffset > fileStat.size;
    const start = reset ? 0 : prior.byteOffset;
    let byteOffset = start;
    let lineNumber = reset ? 0 : prior.lineNumber;
    let lastEventId = reset ? undefined : prior.lastEventId;
    let captured = 0;
    let sessionId = path.basename(options.file, path.extname(options.file));
    const pending: MemoryEventInput[] = [];
    const agentId = resolveAgentId(
      options.agentId ?? this.agentIdFromTranscriptPath(options.file),
      options.sessionKey,
    );
    const input = createReadStream(options.file, { start, encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      byteOffset += Buffer.byteLength(line, "utf8") + 1;
      lineNumber++;
      if (!line.trim()) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A partial final line remains uncommitted and will be retried later.
        byteOffset -= Buffer.byteLength(line, "utf8") + 1;
        lineNumber--;
        break;
      }
      if (parsed.type === "session" && typeof parsed.id === "string") {
        sessionId = parsed.id;
        continue;
      }
      if (parsed.type !== "message") {
        continue;
      }
      const message = asRecord(parsed.message);
      if (!message) {
        continue;
      }
      const role = messageRole(message.role);
      const content = extractText(message.content);
      if (!content) {
        continue;
      }
      const observedAt = timestampMs(message.timestamp) ?? timestampMs(parsed.timestamp);
      const outerId = typeof parsed.id === "string" ? parsed.id : undefined;
      const externalId = stableMessageExternalId({
        role,
        content,
        timestamp: observedAt,
        messageId: outerId,
      });
      pending.push({
        agentId,
        sessionKey: options.sessionKey ?? sessionId,
        role,
        content,
        sourceKind: "transcript_reconcile",
        sourceRef: `${options.file}:${lineNumber}`,
        observedAt,
        externalId,
        metadata: { transcriptId: sessionId, transcriptLine: lineNumber },
      });
      if (pending.length >= 1_000) {
        const stored = this.ledger.appendEvents(pending.splice(0));
        captured += stored.filter((result) => result.inserted).length;
        lastEventId = stored.at(-1)?.event.eventId ?? lastEventId;
      }
    }
    if (pending.length > 0) {
      const stored = this.ledger.appendEvents(pending);
      captured += stored.filter((result) => result.inserted).length;
      lastEventId = stored.at(-1)?.event.eventId ?? lastEventId;
    }
    this.ledger.updateIngestCursor({
      sourcePath: options.file,
      sourceIdentity: identity,
      byteOffset: Math.min(byteOffset, fileStat.size),
      lineNumber,
      lastEventId,
    });
    if (captured > 0) {
      this.scheduleProjection();
    }
    return { lines: lineNumber - (reset ? 0 : prior!.lineNumber), captured, reset };
  }

  async reconcileStateDir(stateDir: string): Promise<{ files: number; captured: number }> {
    const agentsDir = path.join(stateDir, "agents");
    let agentEntries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agentEntries = (await readdir(agentsDir, { withFileTypes: true })) as Array<{
        name: string;
        isDirectory(): boolean;
      }>;
    } catch {
      return { files: 0, captured: 0 };
    }
    let files = 0;
    let captured = 0;
    for (const agent of agentEntries) {
      if (!agent.isDirectory()) {
        continue;
      }
      const sessionsDir = path.join(agentsDir, agent.name, "sessions");
      let sessionEntries: Array<{ name: string; isFile(): boolean }>;
      try {
        sessionEntries = (await readdir(sessionsDir, { withFileTypes: true })) as Array<{
          name: string;
          isFile(): boolean;
        }>;
      } catch {
        continue;
      }
      for (const session of sessionEntries) {
        if (!session.isFile() || !session.name.endsWith(".jsonl")) {
          continue;
        }
        files++;
        const result = await this.reconcileTranscript({
          file: path.join(sessionsDir, session.name),
          agentId: agent.name,
        });
        captured += result.captured;
      }
    }
    return { files, captured };
  }

  scheduleProjection(): void {
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
      .then(() => this.drainProjection())
      .catch((error: unknown) => {
        this.options.logger.warn?.(`memory-v2: projection worker failed: ${String(error)}`);
      })
      .finally(() => {
        this.drainPromise = null;
        if (this.drainRequested && !this.stopped) {
          this.scheduleProjection();
        }
      });
  }

  async flush(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.drainRequested = true;
    while (Date.now() <= deadline) {
      if (!this.drainPromise) {
        await this.drainProjection();
      } else {
        await Promise.race([
          this.drainPromise,
          new Promise<void>((resolve) => {
            setTimeout(resolve, Math.max(1, deadline - Date.now()));
          }),
        ]);
      }
      const stats = this.ledger.getStats();
      if (
        stats.pendingProjection === 0 &&
        stats.retryProjection === 0 &&
        stats.leasedProjection === 0
      ) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.flush(5_000).catch(() => false);
    this.index.close();
    this.ledger.checkpoint("TRUNCATE");
    this.ledger.close();
  }

  private async drainProjection(): Promise<void> {
    this.drainRequested = false;
    for (let pass = 0; pass < MAX_PROJECTION_PASSES_PER_TICK; pass++) {
      const leased = this.ledger.claimProjectionBatch({
        owner: this.workerId,
        limit: this.projectionBatch,
        leaseMs: DEFAULT_PROJECTION_LEASE_MS,
      });
      if (leased.length === 0) {
        return;
      }
      let results: Array<PromiseSettledResult<MemoryProjectionInput>>;
      if (this.options.embeddings.embedBatch) {
        try {
          const vectors = await this.options.embeddings.embedBatch(
            leased.map((event) => event.content),
            { timeoutMs: this.embeddingTimeoutMs },
          );
          if (vectors.length !== leased.length) {
            throw new Error(
              `memory batch embedding returned ${vectors.length} vectors for ${leased.length} events`,
            );
          }
          results = leased.map((event, index) => ({
            status: "fulfilled" as const,
            value: this.projectionForEvent(event, vectors[index]!),
          }));
        } catch (reason) {
          results = leased.map(() => ({ status: "rejected" as const, reason }));
        }
      } else {
        results = await mapConcurrent(
          leased,
          this.projectionConcurrency,
          async (event): Promise<MemoryProjectionInput> =>
            this.projectionForEvent(
              event,
              await this.options.embeddings.embed(event.content, {
                timeoutMs: this.embeddingTimeoutMs,
              }),
            ),
        );
      }
      const successful: MemoryProjectionInput[] = [];
      const successfulEvents: ProjectionLease[] = [];
      results.forEach((result, index) => {
        const event = leased[index]!;
        if (result.status === "fulfilled") {
          successful.push(result.value);
          successfulEvents.push(event);
        } else {
          this.ledger.markProjectionFailed({
            eventId: event.eventId,
            owner: this.workerId,
            error: result.reason,
            retryDelayMs: Math.min(300_000, 2_000 * 2 ** Math.min(event.attempts, 7)),
          });
        }
      });
      if (successful.length > 0) {
        try {
          await this.index.upsertBatch(successful);
          for (const event of successfulEvents) {
            this.ledger.markProjected(event.eventId, this.workerId);
          }
        } catch (error) {
          for (const event of successfulEvents) {
            this.ledger.markProjectionFailed({
              eventId: event.eventId,
              owner: this.workerId,
              error,
              retryDelayMs: Math.min(300_000, 2_000 * 2 ** Math.min(event.attempts, 7)),
            });
          }
        }
      }
      this.maintenanceCounter += leased.length;
      if (this.maintenanceCounter >= 256) {
        this.maintenanceCounter = 0;
        await this.index.ensureIndices().catch((error: unknown) => {
          this.options.logger.warn?.(`memory-v2: index creation deferred: ${String(error)}`);
        });
        await this.index.optimizeIfNeeded().catch((error: unknown) => {
          this.options.logger.warn?.(`memory-v2: index optimization deferred: ${String(error)}`);
        });
      }
    }
    this.drainRequested = true;
  }

  private projectionForEvent(event: ProjectionLease, vector: number[]): MemoryProjectionInput {
    return {
      id: event.eventId,
      recordType: "event",
      text: event.content,
      vector,
      agentId: event.agentId,
      scope: "global",
      sessionKey: event.sessionKey,
      channel: event.channel,
      conversationId: event.conversationId,
      category: typeof event.metadata.category === "string" ? event.metadata.category : event.role,
      status: "active",
      importance:
        typeof event.metadata.importance === "number"
          ? event.metadata.importance
          : projectionImportance(event),
      confidence:
        typeof event.metadata.confidence === "number"
          ? event.metadata.confidence
          : event.role === "user"
            ? 0.9
            : 0.6,
      authority:
        typeof event.metadata.authority === "number"
          ? event.metadata.authority
          : event.role === "user"
            ? 0.95
            : 0.55,
      validFrom: event.validFrom ?? event.observedAt,
      validTo: event.validTo,
      observedAt: event.observedAt,
      sourceEventId: event.eventId,
      tags: [event.role, event.sourceKind],
    };
  }

  private agentIdFromTranscriptPath(file: string): string | undefined {
    const parts = path.normalize(file).split(path.sep);
    const agentsIndex = parts.lastIndexOf("agents");
    return agentsIndex >= 0 ? parts[agentsIndex + 1] : undefined;
  }
}
