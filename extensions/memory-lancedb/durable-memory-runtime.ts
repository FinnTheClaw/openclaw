import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
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
// Causal embedding batches are padded to their longest row. Bounding the
// padded character surface prevents one long transcript message from turning
// an otherwise small batch into a multi-gigabyte MPS attention allocation.
const MAX_PADDED_EMBEDDING_CHARS_PER_BATCH = 30_000;
const WORKSPACE_MARKDOWN_SOURCE_KIND = "workspace_memory_markdown";
const WORKSPACE_MARKDOWN_CHUNK_CHARS = 3_500;
const WORKSPACE_MARKDOWN_RECONCILE_CONCURRENCY = 8;

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

export type WorkspaceMemoryArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: "markdown" | "json" | "text";
};

export type WorkspaceMarkdownReconcileResult = {
  files: number;
  changed: number;
  unchanged: number;
  removed: number;
  preserved: number;
  captured: number;
  errors: number;
};

type MessageCaptureContext = {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  conversationId?: string;
  sourceKind: string;
  sourceRef?: string;
};

type IndexedProjectionLease = {
  event: ProjectionLease;
  index: number;
};

type IndexedProjectionResult = {
  index: number;
  result: PromiseSettledResult<MemoryProjectionInput>;
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

function chunkMarkdown(text: string, maxChars = WORKSPACE_MARKDOWN_CHUNK_CHARS): string[] {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  if (!normalized) {
    return [];
  }
  const blocks = normalized
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    flush();
    if (block.length <= maxChars) {
      current = block;
      continue;
    }
    let remainder = block;
    while (remainder.length > maxChars) {
      let splitAt = remainder.lastIndexOf("\n", maxChars);
      if (splitAt < Math.floor(maxChars * 0.6)) {
        splitAt = remainder.lastIndexOf(" ", maxChars);
      }
      if (splitAt < Math.floor(maxChars * 0.6)) {
        splitAt = maxChars;
      }
      chunks.push(remainder.slice(0, splitAt).trim());
      remainder = remainder.slice(splitAt).trimStart();
    }
    current = remainder;
  }
  flush();
  return chunks.filter(Boolean);
}

function workspaceSourceKey(agentId: string, absolutePath: string): string {
  return `${agentId}\u0000${absolutePath}`;
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

  /**
   * Imports canonical MEMORY.md and recursively discovered memory Markdown artifacts into the durable
   * ledger. SQLite checkpoints make unchanged startup work stat-only, while
   * deterministic event IDs make interrupted updates idempotent. The ledger is
   * authoritative; the vector projection remains rebuildable.
   */
  async reconcileWorkspaceMarkdown(
    artifacts: WorkspaceMemoryArtifact[],
    options?: { activeWorkspaceDirs?: string[] },
  ): Promise<WorkspaceMarkdownReconcileResult> {
    const activeWorkspaceDirs = new Set(
      (options?.activeWorkspaceDirs ?? artifacts.map((artifact) => artifact.workspaceDir)).map(
        (workspaceDir) => path.resolve(workspaceDir),
      ),
    );
    const desired = new Map<
      string,
      { artifact: WorkspaceMemoryArtifact; agentId: string; absolutePath: string }
    >();
    for (const artifact of artifacts) {
      if (artifact.contentType !== "markdown") {
        continue;
      }
      const absolutePath = path.resolve(artifact.absolutePath);
      for (const rawAgentId of artifact.agentIds) {
        const agentId = rawAgentId.trim();
        if (!agentId) {
          continue;
        }
        desired.set(workspaceSourceKey(agentId, absolutePath), { artifact, agentId, absolutePath });
      }
    }

    const totals: WorkspaceMarkdownReconcileResult = {
      files: desired.size,
      changed: 0,
      unchanged: 0,
      removed: 0,
      preserved: 0,
      captured: 0,
      errors: 0,
    };
    const settled = await mapConcurrent(
      [...desired.values()],
      WORKSPACE_MARKDOWN_RECONCILE_CONCURRENCY,
      async (source) => await this.reconcileWorkspaceMarkdownSource(source),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        totals.errors++;
        this.options.logger.warn?.(
          `memory-v2: Markdown reconciliation failed: ${String(result.reason)}`,
        );
        continue;
      }
      totals.changed += result.value.changed ? 1 : 0;
      totals.unchanged += result.value.changed ? 0 : 1;
      totals.captured += result.value.captured;
    }

    for (const checkpoint of this.ledger.listSourceCheckpoints({
      sourceKind: WORKSPACE_MARKDOWN_SOURCE_KIND,
    })) {
      if (desired.has(workspaceSourceKey(checkpoint.agentId, checkpoint.sourcePath))) {
        continue;
      }
      if (activeWorkspaceDirs.has(path.resolve(checkpoint.workspaceDir))) {
        try {
          const existing = await stat(checkpoint.sourcePath);
          if (existing.isFile()) {
            totals.preserved++;
            continue;
          }
        } catch (error) {
          const code = asRecord(error)?.code;
          if (code !== "ENOENT") {
            totals.errors++;
            totals.preserved++;
            this.options.logger.warn?.(
              `memory-v2: preserving undiscovered Markdown source after stat failure: ${String(error)}`,
            );
            continue;
          }
        }
      }
      for (const eventId of checkpoint.eventIds) {
        this.ledger.deleteEvent(eventId, "workspace_memory_source_removed");
        await this.index.delete(eventId);
      }
      this.ledger.deleteSourceCheckpoint(checkpoint);
      totals.removed++;
    }
    if (totals.captured > 0) {
      this.scheduleProjection();
    }
    return totals;
  }

  private async reconcileWorkspaceMarkdownSource(source: {
    artifact: WorkspaceMemoryArtifact;
    agentId: string;
    absolutePath: string;
  }): Promise<{ changed: boolean; captured: number }> {
    const before = await stat(source.absolutePath);
    if (!before.isFile()) {
      throw new Error(`${source.absolutePath} is not a regular file`);
    }
    const sourceIdentity = `${String(before.dev)}:${String(before.ino)}`;
    const prior = this.ledger.getSourceCheckpoint({
      sourceKind: WORKSPACE_MARKDOWN_SOURCE_KIND,
      agentId: source.agentId,
      sourcePath: source.absolutePath,
    });
    if (
      prior?.sourceIdentity === sourceIdentity &&
      prior.sizeBytes === before.size &&
      prior.mtimeMs === before.mtimeMs
    ) {
      return { changed: false, captured: 0 };
    }

    const text = await readFile(source.absolutePath, "utf8");
    const after = await stat(source.absolutePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`${source.absolutePath} changed while it was being read`);
    }
    const contentSha256 = sha256(text);
    if (prior?.contentSha256 === contentSha256) {
      this.ledger.upsertSourceCheckpoint({
        ...prior,
        workspaceDir: path.resolve(source.artifact.workspaceDir),
        sourceIdentity,
        sizeBytes: after.size,
        mtimeMs: after.mtimeMs,
      });
      return { changed: false, captured: 0 };
    }

    const chunks = chunkMarkdown(text);
    const inputs: MemoryEventInput[] = chunks.map((content, chunkIndex) => ({
      agentId: source.agentId,
      role: "user",
      content,
      sourceKind: WORKSPACE_MARKDOWN_SOURCE_KIND,
      sourceRef: `${source.absolutePath}#chunk=${chunkIndex + 1}`,
      observedAt: Math.floor(after.mtimeMs),
      externalId: `workspace-markdown:v1:${sha256(source.absolutePath)}:${contentSha256}:${chunkIndex}`,
      metadata: {
        workspaceDir: source.artifact.workspaceDir,
        relativePath: source.artifact.relativePath,
        artifactKind: source.artifact.kind,
        chunkIndex,
        chunkCount: chunks.length,
        category: source.artifact.kind === "memory-root" ? "canonical" : "episodic",
        importance: source.artifact.kind === "memory-root" ? 0.95 : 0.8,
        confidence: 1,
        authority: source.artifact.kind === "memory-root" ? 1 : 0.9,
      },
    }));
    const stored = this.ledger.appendEvents(inputs);
    const eventIds = stored.map((result) => result.event.eventId);
    const retained = new Set(eventIds);
    for (const eventId of prior?.eventIds ?? []) {
      if (retained.has(eventId)) {
        continue;
      }
      this.ledger.deleteEvent(eventId, "workspace_memory_source_changed");
      await this.index.delete(eventId);
    }
    this.ledger.upsertSourceCheckpoint({
      sourceKind: WORKSPACE_MARKDOWN_SOURCE_KIND,
      agentId: source.agentId,
      workspaceDir: path.resolve(source.artifact.workspaceDir),
      sourcePath: source.absolutePath,
      sourceIdentity,
      sizeBytes: after.size,
      mtimeMs: after.mtimeMs,
      contentSha256,
      eventIds,
    });
    return { changed: true, captured: stored.filter((result) => result.inserted).length };
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
        const indexedResults = Array.from<PromiseSettledResult<MemoryProjectionInput> | undefined>({
          length: leased.length,
        });
        for (const batch of this.projectionEmbeddingBatches(leased)) {
          const batchResults = await this.embedProjectionBatchResilient(batch);
          for (const item of batchResults) {
            indexedResults[item.index] = item.result;
          }
        }
        results = indexedResults.map(
          (result): PromiseSettledResult<MemoryProjectionInput> =>
            result ?? {
              status: "rejected",
              reason: new Error("memory embedding microbatch did not return an indexed result"),
            },
        );
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

  private projectionEmbeddingBatches(leased: ProjectionLease[]): IndexedProjectionLease[][] {
    const ordered = leased
      .map((event, index) => ({ event, index }))
      .toSorted(
        (left, right) =>
          right.event.content.length - left.event.content.length || left.index - right.index,
      );
    const batches: IndexedProjectionLease[][] = [];
    let current: IndexedProjectionLease[] = [];
    let longest = 0;
    for (const item of ordered) {
      const nextLongest = Math.max(longest, item.event.content.length);
      const exceedsCount = current.length >= this.projectionBatch;
      const exceedsPaddedBudget =
        current.length > 0 &&
        nextLongest * (current.length + 1) > MAX_PADDED_EMBEDDING_CHARS_PER_BATCH;
      if (exceedsCount || exceedsPaddedBudget) {
        batches.push(current);
        current = [];
        longest = 0;
      }
      current.push(item);
      longest = Math.max(longest, item.event.content.length);
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private async embedProjectionBatchResilient(
    batch: IndexedProjectionLease[],
  ): Promise<IndexedProjectionResult[]> {
    try {
      const vectors = await this.options.embeddings.embedBatch!(
        batch.map((item) => item.event.content),
        { timeoutMs: this.embeddingTimeoutMs },
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `memory batch embedding returned ${vectors.length} vectors for ${batch.length} events`,
        );
      }
      return batch.map((item, index) => ({
        index: item.index,
        result: {
          status: "fulfilled" as const,
          value: this.projectionForEvent(item.event, vectors[index]!),
        },
      }));
    } catch (reason) {
      if (batch.length === 1) {
        return [{ index: batch[0]!.index, result: { status: "rejected", reason } }];
      }
      const midpoint = Math.ceil(batch.length / 2);
      const left = await this.embedProjectionBatchResilient(batch.slice(0, midpoint));
      const right = await this.embedProjectionBatchResilient(batch.slice(midpoint));
      return [...left, ...right];
    }
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
