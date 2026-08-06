import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA_VERSION = 3;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_PROJECTION_ATTEMPTS = 12;

export type MemoryRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type MemoryEventInput = {
  eventId?: string;
  externalId?: string;
  agentId: string;
  sessionKey?: string;
  channel?: string;
  conversationId?: string;
  role: MemoryRole;
  content: string;
  sourceKind: string;
  sourceRef?: string;
  observedAt?: number;
  validFrom?: number;
  validTo?: number;
  metadata?: Record<string, unknown>;
};

export type StoredMemoryEvent = {
  eventId: string;
  externalId?: string;
  agentId: string;
  sessionKey?: string;
  channel?: string;
  conversationId?: string;
  role: MemoryRole;
  content: string;
  sourceKind: string;
  sourceRef?: string;
  observedAt: number;
  validFrom?: number;
  validTo?: number;
  contentSha256: string;
  metadata: Record<string, unknown>;
};

export type ProjectionLease = StoredMemoryEvent & {
  attempts: number;
  leaseOwner: string;
  leaseUntil: number;
};

export type FactExtractionLease = StoredMemoryEvent & {
  attempts: number;
  leaseOwner: string;
  leaseUntil: number;
};

export type MemorySummaryLevel = "day" | "week" | "month" | "year";

export type StoredSummaryNode = {
  nodeId: string;
  agentId: string;
  scope: string;
  level: MemorySummaryLevel;
  bucketStart: number;
  bucketEnd: number;
  summaryText: string;
  sourceCount: number;
  sourceGeneration: number;
  summarizedGeneration: number;
  targetGeneration: number;
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  updatedAt: number;
};

export type MaterializationLease = {
  recordType: "fact" | "summary";
  recordId: string;
  attempts: number;
  leaseOwner: string;
  leaseUntil: number;
};

export type FactRevisionInput = {
  revisionId?: string;
  factKey?: string;
  agentId: string;
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
  observedAt?: number;
  sourceEventId: string;
  metadata?: Record<string, unknown>;
};

export type StoredFactRevision = {
  revisionId: string;
  factKey: string;
  agentId: string;
  scope: string;
  subject: string;
  predicate: string;
  object: string;
  text: string;
  category: string;
  confidence: number;
  authority: number;
  validFrom: number;
  validTo?: number;
  observedAt: number;
  systemFrom: number;
  systemTo?: number;
  status: "active" | "superseded" | "retracted";
  supersedesRevisionId?: string;
  sourceEventId: string;
  metadata: Record<string, unknown>;
};

export type TemporalLedgerStats = {
  events: number;
  pendingProjection: number;
  leasedProjection: number;
  retryProjection: number;
  deadProjection: number;
  factRevisions: number;
  activeFacts: number;
  dirtySummaries: number;
  pendingExtraction: number;
  deadExtraction: number;
  pendingMaterialization: number;
};

export type DeadLetterQueue = "projection" | "extraction" | "all";

export type DeadLetterRecoveryResult = {
  queue: DeadLetterQueue;
  projection: number;
  extraction: number;
  total: number;
  recoveredAt: number;
};

export type MemoryIngestCursor = {
  sourcePath: string;
  sourceIdentity: string;
  byteOffset: number;
  lineNumber: number;
  lastEventId?: string;
  updatedAt: number;
};

export type MemorySourceCheckpoint = {
  sourceKind: string;
  agentId: string;
  workspaceDir: string;
  sourcePath: string;
  sourceIdentity: string;
  sizeBytes: number;
  mtimeMs: number;
  contentSha256: string;
  eventIds: string[];
  updatedAt: number;
};

type SqlRow = Record<string, unknown>;

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function finiteTimestamp(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function finiteUnitInterval(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stableJson(value: Record<string, unknown> | undefined): string {
  if (!value) {
    return "{}";
  }
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (seen.has(entry)) {
      throw new Error("memory metadata must not contain cycles");
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowToEvent(row: SqlRow): StoredMemoryEvent {
  return {
    eventId: String(row.event_id),
    externalId: optionalString(row.external_id),
    agentId: String(row.agent_id),
    sessionKey: optionalString(row.session_key),
    channel: optionalString(row.channel),
    conversationId: optionalString(row.conversation_id),
    role: String(row.role) as MemoryRole,
    content: String(row.content),
    sourceKind: String(row.source_kind),
    sourceRef: optionalString(row.source_ref),
    observedAt: Number(row.observed_at),
    validFrom: optionalNumber(row.valid_from),
    validTo: optionalNumber(row.valid_to),
    contentSha256: String(row.content_sha256),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function rowToFact(row: SqlRow): StoredFactRevision {
  return {
    revisionId: String(row.revision_id),
    factKey: String(row.fact_key),
    agentId: String(row.agent_id),
    scope: String(row.scope),
    subject: String(row.subject),
    predicate: String(row.predicate),
    object: String(row.object_value),
    text: String(row.text),
    category: String(row.category),
    confidence: Number(row.confidence),
    authority: Number(row.authority),
    validFrom: Number(row.valid_from),
    validTo: optionalNumber(row.valid_to),
    observedAt: Number(row.observed_at),
    systemFrom: Number(row.system_from),
    systemTo: optionalNumber(row.system_to),
    status: String(row.status) as StoredFactRevision["status"],
    supersedesRevisionId: optionalString(row.supersedes_revision_id),
    sourceEventId: String(row.source_event_id),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function rowToSummary(row: SqlRow): StoredSummaryNode {
  return {
    nodeId: String(row.node_id),
    agentId: String(row.agent_id),
    scope: String(row.scope),
    level: String(row.level) as MemorySummaryLevel,
    bucketStart: Number(row.bucket_start),
    bucketEnd: Number(row.bucket_end),
    summaryText: String(row.summary_text),
    sourceCount: Number(row.source_count),
    sourceGeneration: Number(row.source_generation),
    summarizedGeneration: Number(row.summarized_generation),
    targetGeneration: Number(row.target_generation ?? row.source_generation),
    attempts: Number(row.attempts),
    leaseOwner: optionalString(row.lease_owner),
    leaseUntil: optionalNumber(row.lease_until),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSourceCheckpoint(row: SqlRow): MemorySourceCheckpoint {
  let eventIds: string[] = [];
  if (typeof row.event_ids_json === "string") {
    try {
      const parsed = JSON.parse(row.event_ids_json) as unknown;
      if (Array.isArray(parsed)) {
        eventIds = parsed.filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
      }
    } catch {
      // A malformed checkpoint is treated as empty so reconciliation safely rebuilds it.
    }
  }
  return {
    sourceKind: String(row.source_kind),
    agentId: String(row.agent_id),
    workspaceDir: String(row.workspace_dir),
    sourcePath: String(row.source_path),
    sourceIdentity: String(row.source_identity),
    sizeBytes: Number(row.size_bytes),
    mtimeMs: Number(row.mtime_ms),
    contentSha256: String(row.content_sha256),
    eventIds,
    updatedAt: Number(row.updated_at),
  };
}

function utcBucket(timestamp: number, level: MemorySummaryLevel): { start: number; end: number } {
  const date = new Date(timestamp);
  let start: number;
  if (level === "day") {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return { start, end: start + 86_400_000 };
  }
  if (level === "week") {
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    start = dayStart - mondayOffset * 86_400_000;
    return { start, end: start + 7 * 86_400_000 };
  }
  if (level === "month") {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
  }
  start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return { start, end: Date.UTC(date.getUTCFullYear() + 1, 0, 1) };
}

/**
 * Authoritative, append-only memory ledger.
 *
 * Search code must never scan the events table. Events are durable ground truth;
 * LanceDB and the current-fact indexes are projections that can be rebuilt.
 */
export class TemporalMemoryLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX mode semantics.
    }
    this.configure();
    this.migrate();
  }

  private configure(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA wal_autocheckpoint=1000");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,
        external_id TEXT,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        channel TEXT,
        conversation_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        observed_at INTEGER NOT NULL,
        valid_from INTEGER,
        valid_to INTEGER,
        content_sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        deleted_at INTEGER
      ) STRICT;

      DROP INDEX IF EXISTS memory_events_external_id;
      CREATE UNIQUE INDEX IF NOT EXISTS memory_events_external_id
        ON memory_events(agent_id, external_id)
        WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS memory_events_session_time
        ON memory_events(agent_id, session_key, observed_at);
      CREATE INDEX IF NOT EXISTS memory_events_agent_time
        ON memory_events(agent_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS memory_events_hash
        ON memory_events(agent_id, content_sha256);

      CREATE TABLE IF NOT EXISTS memory_deletion_audit (
        deletion_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        external_id TEXT,
        agent_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        reason TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS memory_deleted_external_id
        ON memory_deletion_audit(agent_id, external_id)
        WHERE external_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_projection_outbox (
        event_id TEXT PRIMARY KEY REFERENCES memory_events(event_id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'leased', 'retry', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_projection_ready
        ON memory_projection_outbox(state, next_attempt_at, lease_until, updated_at);

      CREATE TABLE IF NOT EXISTS memory_fact_extraction_outbox (
        event_id TEXT PRIMARY KEY REFERENCES memory_events(event_id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'leased', 'retry', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_fact_extraction_ready
        ON memory_fact_extraction_outbox(state, next_attempt_at, lease_until, updated_at);

      CREATE TABLE IF NOT EXISTS memory_materialization_outbox (
        record_type TEXT NOT NULL CHECK(record_type IN ('fact', 'summary')),
        record_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'leased', 'retry', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(record_type, record_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS memory_materialization_ready
        ON memory_materialization_outbox(state, next_attempt_at, lease_until, updated_at);

                CREATE TABLE IF NOT EXISTS memory_ingest_cursors (
        source_path TEXT PRIMARY KEY,
        source_identity TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_number INTEGER NOT NULL DEFAULT 0,
        last_event_id TEXT,
        updated_at INTEGER NOT NULL
                ) STRICT;

                CREATE TABLE IF NOT EXISTS memory_source_checkpoints (
                  source_kind TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  workspace_dir TEXT NOT NULL,
                  source_path TEXT NOT NULL,
                  source_identity TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  mtime_ms REAL NOT NULL,
                  content_sha256 TEXT NOT NULL,
                  event_ids_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY(source_kind, agent_id, source_path)
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS memory_source_checkpoints_kind
                  ON memory_source_checkpoints(source_kind, agent_id, updated_at);

      CREATE TABLE IF NOT EXISTS memory_fact_revisions (
        revision_id TEXT PRIMARY KEY,
        fact_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_value TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        authority REAL NOT NULL CHECK(authority >= 0 AND authority <= 1),
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        observed_at INTEGER NOT NULL,
        system_from INTEGER NOT NULL,
        system_to INTEGER,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'retracted')),
        supersedes_revision_id TEXT REFERENCES memory_fact_revisions(revision_id),
        source_event_id TEXT NOT NULL REFERENCES memory_events(event_id),
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS memory_one_active_fact
        ON memory_fact_revisions(agent_id, scope, fact_key)
        WHERE status = 'active' AND system_to IS NULL;
      CREATE INDEX IF NOT EXISTS memory_fact_exact_lookup
        ON memory_fact_revisions(agent_id, scope, subject, predicate, status, system_to);
      CREATE INDEX IF NOT EXISTS memory_fact_temporal_lookup
        ON memory_fact_revisions(agent_id, scope, fact_key, valid_from, valid_to, system_from);

      CREATE TABLE IF NOT EXISTS memory_fact_evidence (
        revision_id TEXT NOT NULL REFERENCES memory_fact_revisions(revision_id),
        event_id TEXT NOT NULL REFERENCES memory_events(event_id),
        observed_at INTEGER NOT NULL,
        PRIMARY KEY(revision_id, event_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS memory_summary_nodes (
        node_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('episode', 'day', 'week', 'month', 'year')),
        bucket_start INTEGER NOT NULL,
        bucket_end INTEGER NOT NULL,
        summary_text TEXT NOT NULL DEFAULT '',
        source_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0, 1)),
        source_generation INTEGER NOT NULL DEFAULT 0,
        summarized_generation INTEGER NOT NULL DEFAULT 0,
        target_generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        dead INTEGER NOT NULL DEFAULT 0 CHECK(dead IN (0, 1)),
        updated_at INTEGER NOT NULL,
        UNIQUE(agent_id, scope, level, bucket_start)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_dirty_summary_nodes
        ON memory_summary_nodes(dirty, level, bucket_start);
    `);

    this.ensureColumn("memory_summary_nodes", "source_generation", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn(
      "memory_summary_nodes",
      "summarized_generation",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn("memory_summary_nodes", "target_generation", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memory_summary_nodes", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memory_summary_nodes", "lease_owner", "TEXT");
    this.ensureColumn("memory_summary_nodes", "lease_until", "INTEGER");
    this.ensureColumn("memory_summary_nodes", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memory_summary_nodes", "last_error", "TEXT");
    this.ensureColumn("memory_summary_nodes", "dead", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      DROP INDEX IF EXISTS memory_dirty_summary_nodes;
      CREATE INDEX memory_dirty_summary_nodes
        ON memory_summary_nodes(dirty, dead, next_attempt_at, lease_until, level, bucket_start);
    `);

    const existing = this.db
      .prepare("SELECT value FROM memory_metadata WHERE key = 'schema_version'")
      .get() as SqlRow | undefined;
    if (existing && Number(existing.value) > SCHEMA_VERSION) {
      throw new Error(
        `memory ledger schema ${String(existing.value)} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO memory_metadata(key, value) VALUES('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(SCHEMA_VERSION));
  }

  private ensureColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (columns.some((column) => String(column.name) === name)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  appendEvent(input: MemoryEventInput): { event: StoredMemoryEvent; inserted: boolean } {
    this.assertOpen();
    return this.appendEvents([input])[0]!;
  }

  /**
   * Atomically imports a bounded transcript/backfill batch with one durable
   * commit. Live hooks should continue to call appendEvent so each message is
   * durable before OpenClaw proceeds.
   */
  appendEvents(inputs: MemoryEventInput[]): Array<{
    event: StoredMemoryEvent;
    inserted: boolean;
  }> {
    this.assertOpen();
    if (inputs.length === 0) {
      return [];
    }
    if (inputs.length > 10_000) {
      throw new Error("memory event batch must contain at most 10000 events");
    }
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO memory_events(
        event_id, external_id, agent_id, session_key, channel, conversation_id,
        role, content, source_kind, source_ref, observed_at, valid_from, valid_to,
        content_sha256, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOutbox = this.db.prepare(
      "INSERT INTO memory_projection_outbox(event_id, state, updated_at) VALUES(?, 'pending', ?)",
    );
    const insertExtraction = this.db.prepare(
      "INSERT INTO memory_fact_extraction_outbox(event_id, state, updated_at) " +
        "VALUES(?, 'pending', ?)",
    );
    const selectEvent = this.db.prepare("SELECT * FROM memory_events WHERE event_id = ?");
    const selectExternalEvent = this.db.prepare(
      "SELECT * FROM memory_events WHERE agent_id = ? AND external_id = ?",
    );
    const results: Array<{ event: StoredMemoryEvent; inserted: boolean }> = [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const input of inputs) {
        const now = Date.now();
        const agentId = normalizeRequired(input.agentId, "agentId");
        const sourceKind = normalizeRequired(input.sourceKind, "sourceKind");
        const content = normalizeRequired(input.content, "content");
        const externalId = normalizeOptional(input.externalId);
        const eventId =
          normalizeOptional(input.eventId) ??
          (externalId ? `evt_${sha256(`${agentId}\u0000${externalId}`)}` : randomUUID());
        const observedAt = finiteTimestamp(input.observedAt, now);
        const values: SQLInputValue[] = [
          eventId,
          externalId ?? null,
          agentId,
          normalizeOptional(input.sessionKey) ?? null,
          normalizeOptional(input.channel) ?? null,
          normalizeOptional(input.conversationId) ?? null,
          input.role,
          content,
          sourceKind,
          normalizeOptional(input.sourceRef) ?? null,
          observedAt,
          input.validFrom === undefined ? null : finiteTimestamp(input.validFrom, observedAt),
          input.validTo === undefined ? null : finiteTimestamp(input.validTo, observedAt),
          sha256(content),
          stableJson(input.metadata),
        ];
        const inserted = insertEvent.run(...values).changes > 0;
        if (inserted) {
          insertOutbox.run(eventId, now);
          if (input.role === "user" || input.role === "assistant") {
            insertExtraction.run(eventId, now);
          }
        }
        const row = (selectEvent.get(eventId) ??
          (externalId ? selectExternalEvent.get(agentId, externalId) : undefined)) as
          | SqlRow
          | undefined;
        if (!row) {
          throw new Error(`memory event ${eventId} was not readable after append`);
        }
        results.push({ event: rowToEvent(row), inserted });
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimProjectionBatch(options: {
    owner: string;
    limit: number;
    leaseMs?: number;
    now?: number;
  }): ProjectionLease[] {
    this.assertOpen();
    const owner = normalizeRequired(options.owner, "owner");
    const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit)));
    const now = finiteTimestamp(options.now, Date.now());
    const leaseUntil = now + Math.max(1_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`
          SELECT event_id
          FROM memory_projection_outbox
          WHERE (
            (state IN ('pending', 'retry') AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_until <= ?)
          )
          ORDER BY updated_at ASC, event_id ASC
          LIMIT ?
        `)
        .all(now, now, limit) as SqlRow[];
      const ids = rows.map((row) => String(row.event_id));
      const update = this.db.prepare(`
        UPDATE memory_projection_outbox
        SET state = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
            updated_at = ?
        WHERE event_id = ?
      `);
      for (const id of ids) {
        update.run(owner, leaseUntil, now, id);
      }
      const select = this.db.prepare(`
        SELECT e.*, o.attempts, o.lease_owner, o.lease_until
        FROM memory_projection_outbox o
        JOIN memory_events e ON e.event_id = o.event_id
        WHERE o.event_id = ? AND o.state = 'leased' AND o.lease_owner = ?
      `);
      const leased = ids
        .map((id) => select.get(id, owner) as SqlRow | undefined)
        .filter((row): row is SqlRow => Boolean(row))
        .map((row) =>
          Object.assign(rowToEvent(row), {
            attempts: Number(row.attempts),
            leaseOwner: String(row.lease_owner),
            leaseUntil: Number(row.lease_until),
          }),
        );
      this.db.exec("COMMIT");
      return leased;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markProjected(eventId: string, owner: string): boolean {
    this.assertOpen();
    const result = this.db
      .prepare(
        "DELETE FROM memory_projection_outbox " +
          "WHERE event_id = ? AND state = 'leased' AND lease_owner = ?",
      )
      .run(normalizeRequired(eventId, "eventId"), normalizeRequired(owner, "owner"));
    return result.changes > 0;
  }

  markProjectionFailed(options: {
    eventId: string;
    owner: string;
    error: unknown;
    retryDelayMs?: number;
    maxAttempts?: number;
    now?: number;
  }): "retry" | "dead" | "not-owned" {
    this.assertOpen();
    const now = finiteTimestamp(options.now, Date.now());
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS),
    );
    const row = this.db
      .prepare(
        "SELECT attempts FROM memory_projection_outbox " +
          "WHERE event_id = ? AND state = 'leased' AND lease_owner = ?",
      )
      .get(options.eventId, options.owner) as SqlRow | undefined;
    if (!row) {
      return "not-owned";
    }
    const state = Number(row.attempts) >= maxAttempts ? "dead" : "retry";
    const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 5_000));
    this.db
      .prepare(`
        UPDATE memory_projection_outbox
        SET state = ?, lease_owner = NULL, lease_until = NULL, next_attempt_at = ?,
            last_error = ?, updated_at = ?
        WHERE event_id = ? AND state = 'leased' AND lease_owner = ?
      `)
      .run(
        state,
        state === "retry" ? now + retryDelayMs : 0,
        String(options.error).slice(0, 2_000),
        now,
        options.eventId,
        options.owner,
      );
    return state;
  }

  claimFactExtractionBatch(options: {
    owner: string;
    limit: number;
    leaseMs?: number;
    now?: number;
  }): FactExtractionLease[] {
    this.assertOpen();
    const owner = normalizeRequired(options.owner, "owner");
    const limit = Math.min(256, Math.max(1, Math.floor(options.limit)));
    const now = finiteTimestamp(options.now, Date.now());
    const leaseUntil = now + Math.max(1_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`
          SELECT event_id FROM memory_fact_extraction_outbox
          WHERE (
            (state IN ('pending', 'retry') AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_until <= ?)
          )
          ORDER BY updated_at ASC, event_id ASC LIMIT ?
        `)
        .all(now, now, limit) as SqlRow[];
      const ids = rows.map((row) => String(row.event_id));
      const update = this.db.prepare(`
        UPDATE memory_fact_extraction_outbox
        SET state = 'leased', lease_owner = ?, lease_until = ?,
            attempts = attempts + 1, updated_at = ?
        WHERE event_id = ?
      `);
      const select = this.db.prepare(`
        SELECT e.*, o.attempts, o.lease_owner, o.lease_until
        FROM memory_fact_extraction_outbox o
        JOIN memory_events e ON e.event_id = o.event_id
        WHERE o.event_id = ? AND o.state = 'leased' AND o.lease_owner = ?
          AND e.deleted_at IS NULL
      `);
      const leased: FactExtractionLease[] = [];
      for (const id of ids) {
        update.run(owner, leaseUntil, now, id);
        const row = select.get(id, owner) as SqlRow | undefined;
        if (row) {
          leased.push({
            ...rowToEvent(row),
            attempts: Number(row.attempts),
            leaseOwner: String(row.lease_owner),
            leaseUntil: Number(row.lease_until),
          });
        }
      }
      this.db.exec("COMMIT");
      return leased;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markFactExtractionCompleted(eventId: string, owner: string): boolean {
    this.assertOpen();
    return (
      this.db
        .prepare(
          "DELETE FROM memory_fact_extraction_outbox " +
            "WHERE event_id = ? AND state = 'leased' AND lease_owner = ?",
        )
        .run(normalizeRequired(eventId, "eventId"), normalizeRequired(owner, "owner")).changes > 0
    );
  }

  markFactExtractionFailed(options: {
    eventId: string;
    owner: string;
    error: unknown;
    retryDelayMs?: number;
    maxAttempts?: number;
    now?: number;
  }): "retry" | "dead" | "not-owned" {
    this.assertOpen();
    const now = finiteTimestamp(options.now, Date.now());
    const row = this.db
      .prepare(
        "SELECT attempts FROM memory_fact_extraction_outbox " +
          "WHERE event_id = ? AND state = 'leased' AND lease_owner = ?",
      )
      .get(options.eventId, options.owner) as SqlRow | undefined;
    if (!row) {
      return "not-owned";
    }
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS),
    );
    const state = Number(row.attempts) >= maxAttempts ? "dead" : "retry";
    const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 5_000));
    this.db
      .prepare(`
        UPDATE memory_fact_extraction_outbox
        SET state = ?, lease_owner = NULL, lease_until = NULL, next_attempt_at = ?,
            last_error = ?, updated_at = ?
        WHERE event_id = ? AND state = 'leased' AND lease_owner = ?
      `)
      .run(
        state,
        state === "retry" ? now + retryDelayMs : 0,
        String(options.error).slice(0, 2_000),
        now,
        options.eventId,
        options.owner,
      );
    return state;
  }

  /**
   * Atomically makes explicitly selected dead-letter work eligible for a new
   * processing cycle. Source events and their prior diagnostic errors remain
   * intact; only queue ownership, timing, and attempt state are reset.
   * Repeating the same recovery is therefore safe and returns zero changes.
   */
  requeueDeadLetters(options: { queue: DeadLetterQueue; now?: number }): DeadLetterRecoveryResult {
    this.assertOpen();
    const queue = options.queue;
    if (queue !== "projection" && queue !== "extraction" && queue !== "all") {
      throw new Error("queue must be projection, extraction, or all");
    }
    const recoveredAt = finiteTimestamp(options.now, Date.now());
    let projection = 0;
    let extraction = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (queue === "projection" || queue === "all") {
        projection = Number(
          this.db
            .prepare(`
              UPDATE memory_projection_outbox
              SET state = 'pending', attempts = 0, lease_owner = NULL,
                  lease_until = NULL, next_attempt_at = 0, updated_at = ?
              WHERE state = 'dead'
            `)
            .run(recoveredAt).changes,
        );
      }
      if (queue === "extraction" || queue === "all") {
        extraction = Number(
          this.db
            .prepare(`
              UPDATE memory_fact_extraction_outbox
              SET state = 'pending', attempts = 0, lease_owner = NULL,
                  lease_until = NULL, next_attempt_at = 0, updated_at = ?
              WHERE state = 'dead'
            `)
            .run(recoveredAt).changes,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      queue,
      projection,
      extraction,
      total: projection + extraction,
      recoveredAt,
    };
  }

  /** Explicit user deletion is the only count-reducing path. It records a
   * content-free tombstone so transcript reconciliation cannot resurrect the
   * deleted memory. Capacity maintenance never calls this method. */
  deleteEvent(eventId: string, reason = "explicit_forget"): boolean {
    this.assertOpen();
    const normalizedId = normalizeRequired(eventId, "eventId");
    const row = this.db
      .prepare(
        "SELECT event_id, external_id, agent_id, content_sha256 FROM memory_events WHERE event_id = ?",
      )
      .get(normalizedId) as SqlRow | undefined;
    if (!row) {
      return false;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const affectedFacts = this.db
        .prepare(
          "SELECT revision_id FROM memory_fact_revisions " +
            "WHERE source_event_id = ? AND status = 'active' AND system_to IS NULL",
        )
        .all(normalizedId) as SqlRow[];
      this.db
        .prepare(`
          INSERT OR IGNORE INTO memory_deletion_audit(
            deletion_id, event_id, external_id, agent_id, content_sha256, reason, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          String(row.event_id),
          optionalString(row.external_id) ?? null,
          String(row.agent_id),
          String(row.content_sha256),
          normalizeRequired(reason, "reason"),
          Date.now(),
        );
      const deletedAt = Date.now();
      this.db
        .prepare(`
          UPDATE memory_events
          SET content = '', metadata_json = '{}', source_ref = NULL, deleted_at = ?
          WHERE event_id = ?
        `)
        .run(deletedAt, normalizedId);
      this.db.prepare("DELETE FROM memory_projection_outbox WHERE event_id = ?").run(normalizedId);
      this.db
        .prepare("DELETE FROM memory_fact_extraction_outbox WHERE event_id = ?")
        .run(normalizedId);
      this.db
        .prepare(`
          UPDATE memory_fact_revisions
          SET status = 'retracted', system_to = ?
          WHERE source_event_id = ? AND status = 'active' AND system_to IS NULL
        `)
        .run(deletedAt, normalizedId);
      const enqueueMaterialization = this.db.prepare(`
        INSERT INTO memory_materialization_outbox(record_type, record_id, state, updated_at)
        VALUES('fact', ?, 'pending', ?)
        ON CONFLICT(record_type, record_id) DO UPDATE SET
          state = 'pending', lease_owner = NULL, lease_until = NULL,
          next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at
      `);
      for (const fact of affectedFacts) {
        enqueueMaterialization.run(String(fact.revision_id), deletedAt);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendFactRevision(input: FactRevisionInput): {
    fact: StoredFactRevision;
    inserted: boolean;
  } {
    this.assertOpen();
    const now = Date.now();
    const agentId = normalizeRequired(input.agentId, "agentId");
    const scope = normalizeOptional(input.scope) ?? "global";
    const subject = normalizeRequired(input.subject, "subject");
    const predicate = normalizeRequired(input.predicate, "predicate");
    const object = normalizeRequired(input.object, "object");
    const text = normalizeRequired(input.text, "text");
    const sourceEventId = normalizeRequired(input.sourceEventId, "sourceEventId");
    const factKey =
      normalizeOptional(input.factKey) ??
      `fact_${sha256(`${agentId}\u0000${scope}\u0000${subject}\u0000${predicate}`)}`;
    const observedAt = finiteTimestamp(input.observedAt, now);
    const validFrom = finiteTimestamp(input.validFrom, observedAt);
    const category = normalizeOptional(input.category) ?? "fact";
    const confidence = finiteUnitInterval(input.confidence, 0.8);
    const authority = finiteUnitInterval(input.authority, 0.5);
    const metadataJson = stableJson(input.metadata);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const source = this.db
        .prepare("SELECT event_id FROM memory_events WHERE event_id = ?")
        .get(sourceEventId);
      if (!source) {
        throw new Error(`source memory event ${sourceEventId} does not exist`);
      }
      const currentRow = this.db
        .prepare(`
          SELECT * FROM memory_fact_revisions
          WHERE agent_id = ? AND scope = ? AND fact_key = ?
            AND status = 'active' AND system_to IS NULL
        `)
        .get(agentId, scope, factKey) as SqlRow | undefined;
      if (
        currentRow &&
        String(currentRow.object_value) === object &&
        String(currentRow.text) === text
      ) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO memory_fact_evidence(revision_id, event_id, observed_at) " +
              "VALUES(?, ?, ?)",
          )
          .run(String(currentRow.revision_id), sourceEventId, observedAt);
        this.db.exec("COMMIT");
        return { fact: rowToFact(currentRow), inserted: false };
      }

      const supersedesRevisionId = currentRow ? String(currentRow.revision_id) : undefined;
      if (supersedesRevisionId) {
        this.db
          .prepare(`
            UPDATE memory_fact_revisions
            SET status = 'superseded', system_to = ?
            WHERE revision_id = ? AND status = 'active' AND system_to IS NULL
          `)
          .run(now, supersedesRevisionId);
        this.enqueueMaterialization("fact", supersedesRevisionId, now);
      }
      const revisionId =
        normalizeOptional(input.revisionId) ??
        `rev_${sha256(`${factKey}\u0000${sourceEventId}\u0000${object}\u0000${text}`)}`;
      this.db
        .prepare(`
          INSERT INTO memory_fact_revisions(
            revision_id, fact_key, agent_id, scope, subject, predicate, object_value,
            text, category, confidence, authority, valid_from, valid_to, observed_at,
            system_from, system_to, status, supersedes_revision_id, source_event_id,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?)
        `)
        .run(
          revisionId,
          factKey,
          agentId,
          scope,
          subject,
          predicate,
          object,
          text,
          category,
          confidence,
          authority,
          validFrom,
          input.validTo === undefined ? null : finiteTimestamp(input.validTo, observedAt),
          observedAt,
          now,
          supersedesRevisionId ?? null,
          sourceEventId,
          metadataJson,
        );
      this.db
        .prepare(
          "INSERT INTO memory_fact_evidence(revision_id, event_id, observed_at) VALUES(?, ?, ?)",
        )
        .run(revisionId, sourceEventId, observedAt);
      this.enqueueMaterialization("fact", revisionId, now);
      this.markSummaryPathDirty({ agentId, scope, observedAt: validFrom, now });
      const insertedRow = this.db
        .prepare("SELECT * FROM memory_fact_revisions WHERE revision_id = ?")
        .get(revisionId) as SqlRow | undefined;
      if (!insertedRow) {
        throw new Error(`fact revision ${revisionId} was not readable after append`);
      }
      this.db.exec("COMMIT");
      return { fact: rowToFact(insertedRow), inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueueMaterialization(
    recordType: MaterializationLease["recordType"],
    recordId: string,
    now: number,
  ): void {
    this.db
      .prepare(`
        INSERT INTO memory_materialization_outbox(record_type, record_id, state, updated_at)
        VALUES(?, ?, 'pending', ?)
        ON CONFLICT(record_type, record_id) DO UPDATE SET
          state = 'pending', lease_owner = NULL, lease_until = NULL,
          next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at
      `)
      .run(recordType, recordId, now);
  }

  private markSummaryPathDirty(options: {
    agentId: string;
    scope: string;
    observedAt: number;
    now: number;
  }): void {
    const upsert = this.db.prepare(`
      INSERT INTO memory_summary_nodes(
        node_id, agent_id, scope, level, bucket_start, bucket_end,
        source_count, dirty, source_generation, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 1, 1, 1, ?)
      ON CONFLICT(agent_id, scope, level, bucket_start) DO UPDATE SET
        source_count = memory_summary_nodes.source_count + 1,
        source_generation = memory_summary_nodes.source_generation + 1,
        dirty = 1,
        dead = 0,
        attempts = 0,
        next_attempt_at = 0,
        last_error = NULL,
        updated_at = excluded.updated_at
    `);
    for (const level of ["day", "week", "month", "year"] as const) {
      const bucket = utcBucket(options.observedAt, level);
      const nodeId = `sum_${sha256(
        `${options.agentId}\u0000${options.scope}\u0000${level}\u0000${bucket.start}`,
      )}`;
      upsert.run(
        nodeId,
        options.agentId,
        options.scope,
        level,
        bucket.start,
        bucket.end,
        options.now,
      );
    }
  }

  findCurrentFacts(options: {
    agentId: string;
    scope?: string;
    subject?: string;
    predicate?: string;
    factKey?: string;
    limit?: number;
  }): StoredFactRevision[] {
    this.assertOpen();
    const predicates = ["agent_id = ?", "scope = ?", "status = 'active'", "system_to IS NULL"];
    const values: SQLInputValue[] = [options.agentId, options.scope ?? "global"];
    if (options.factKey) {
      predicates.push("fact_key = ?");
      values.push(options.factKey);
    }
    if (options.subject) {
      predicates.push("subject = ?");
      values.push(options.subject);
    }
    if (options.predicate) {
      predicates.push("predicate = ?");
      values.push(options.predicate);
    }
    const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit ?? 20)));
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_fact_revisions WHERE ${predicates.join(" AND ")} ` +
          "ORDER BY authority DESC, confidence DESC, observed_at DESC LIMIT ?",
      )
      .all(...values) as SqlRow[];
    return rows.map(rowToFact);
  }

  getFactRevision(revisionId: string): StoredFactRevision | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM memory_fact_revisions WHERE revision_id = ?")
      .get(normalizeRequired(revisionId, "revisionId")) as SqlRow | undefined;
    return row ? rowToFact(row) : undefined;
  }

  claimSummaryBatch(options: {
    owner: string;
    limit: number;
    leaseMs?: number;
    now?: number;
  }): StoredSummaryNode[] {
    this.assertOpen();
    const owner = normalizeRequired(options.owner, "owner");
    const limit = Math.min(64, Math.max(1, Math.floor(options.limit)));
    const now = finiteTimestamp(options.now, Date.now());
    const leaseUntil = now + Math.max(1_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`
          SELECT node_id FROM memory_summary_nodes
          WHERE dirty = 1 AND dead = 0 AND next_attempt_at <= ?
            AND (lease_owner IS NULL OR lease_until <= ?)
          ORDER BY CASE level
            WHEN 'day' THEN 1 WHEN 'week' THEN 2 WHEN 'month' THEN 3 ELSE 4 END,
            bucket_start ASC
          LIMIT ?
        `)
        .all(now, now, limit) as SqlRow[];
      const ids = rows.map((row) => String(row.node_id));
      const update = this.db.prepare(`
        UPDATE memory_summary_nodes
        SET lease_owner = ?, lease_until = ?, target_generation = source_generation,
            attempts = attempts + 1, updated_at = ?
        WHERE node_id = ? AND dirty = 1 AND dead = 0
      `);
      const select = this.db.prepare(
        "SELECT * FROM memory_summary_nodes WHERE node_id = ? AND lease_owner = ?",
      );
      const leased: StoredSummaryNode[] = [];
      for (const id of ids) {
        update.run(owner, leaseUntil, now, id);
        const row = select.get(id, owner) as SqlRow | undefined;
        if (row) {
          leased.push(rowToSummary(row));
        }
      }
      this.db.exec("COMMIT");
      return leased;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSummarySources(node: StoredSummaryNode, limit = 256): string[] {
    this.assertOpen();
    const boundedLimit = Math.min(1_000, Math.max(1, Math.floor(limit)));
    if (node.level !== "day") {
      const childLevel: MemorySummaryLevel =
        node.level === "week" ? "day" : node.level === "month" ? "week" : "month";
      const rows = this.db
        .prepare(`
          SELECT summary_text FROM memory_summary_nodes
          WHERE agent_id = ? AND scope = ? AND level = ?
            AND bucket_start >= ? AND bucket_start < ?
            AND summarized_generation > 0 AND summary_text <> ''
          ORDER BY bucket_start ASC LIMIT ?
        `)
        .all(
          node.agentId,
          node.scope,
          childLevel,
          node.bucketStart,
          node.bucketEnd,
          boundedLimit,
        ) as SqlRow[];
      if (rows.length > 0) {
        return rows.map((row) => String(row.summary_text));
      }
    }
    const rows = this.db
      .prepare(`
        SELECT text FROM memory_fact_revisions
        WHERE agent_id = ? AND scope = ? AND status = 'active' AND system_to IS NULL
          AND valid_from >= ? AND valid_from < ?
        ORDER BY authority DESC, confidence DESC, observed_at ASC LIMIT ?
      `)
      .all(node.agentId, node.scope, node.bucketStart, node.bucketEnd, boundedLimit) as SqlRow[];
    return rows.map((row) => String(row.text));
  }

  completeSummary(options: {
    nodeId: string;
    owner: string;
    targetGeneration: number;
    summaryText: string;
    now?: number;
  }): boolean {
    this.assertOpen();
    const now = finiteTimestamp(options.now, Date.now());
    const nodeId = normalizeRequired(options.nodeId, "nodeId");
    const result = this.db
      .prepare(`
        UPDATE memory_summary_nodes
        SET summary_text = ?, summarized_generation = ?,
            dirty = CASE WHEN source_generation > ? THEN 1 ELSE 0 END,
            lease_owner = NULL, lease_until = NULL, attempts = 0,
            next_attempt_at = 0, last_error = NULL, updated_at = ?
        WHERE node_id = ? AND lease_owner = ? AND target_generation = ?
      `)
      .run(
        normalizeRequired(options.summaryText, "summaryText"),
        options.targetGeneration,
        options.targetGeneration,
        now,
        nodeId,
        normalizeRequired(options.owner, "owner"),
        options.targetGeneration,
      );
    if (result.changes > 0) {
      this.enqueueMaterialization("summary", nodeId, now);
      return true;
    }
    return false;
  }

  markSummaryFailed(options: {
    nodeId: string;
    owner: string;
    error: unknown;
    retryDelayMs?: number;
    maxAttempts?: number;
    now?: number;
  }): "retry" | "dead" | "not-owned" {
    this.assertOpen();
    const now = finiteTimestamp(options.now, Date.now());
    const row = this.db
      .prepare("SELECT attempts FROM memory_summary_nodes WHERE node_id = ? AND lease_owner = ?")
      .get(options.nodeId, options.owner) as SqlRow | undefined;
    if (!row) {
      return "not-owned";
    }
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS),
    );
    const dead = Number(row.attempts) >= maxAttempts;
    this.db
      .prepare(`
        UPDATE memory_summary_nodes
        SET lease_owner = NULL, lease_until = NULL, dead = ?, next_attempt_at = ?,
            last_error = ?, updated_at = ?
        WHERE node_id = ? AND lease_owner = ?
      `)
      .run(
        dead ? 1 : 0,
        dead ? 0 : now + Math.max(0, Math.floor(options.retryDelayMs ?? 5_000)),
        String(options.error).slice(0, 2_000),
        now,
        options.nodeId,
        options.owner,
      );
    return dead ? "dead" : "retry";
  }

  claimMaterializationBatch(options: {
    owner: string;
    limit: number;
    leaseMs?: number;
    now?: number;
  }): MaterializationLease[] {
    this.assertOpen();
    const owner = normalizeRequired(options.owner, "owner");
    const limit = Math.min(256, Math.max(1, Math.floor(options.limit)));
    const now = finiteTimestamp(options.now, Date.now());
    const leaseUntil = now + Math.max(1_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`
          SELECT record_type, record_id FROM memory_materialization_outbox
          WHERE (
            (state IN ('pending', 'retry') AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_until <= ?)
          )
          ORDER BY updated_at ASC, record_type ASC, record_id ASC LIMIT ?
        `)
        .all(now, now, limit) as SqlRow[];
      const update = this.db.prepare(`
        UPDATE memory_materialization_outbox
        SET state = 'leased', lease_owner = ?, lease_until = ?,
            attempts = attempts + 1, updated_at = ?
        WHERE record_type = ? AND record_id = ?
      `);
      const select = this.db.prepare(`
        SELECT * FROM memory_materialization_outbox
        WHERE record_type = ? AND record_id = ? AND state = 'leased' AND lease_owner = ?
      `);
      const leased: MaterializationLease[] = [];
      for (const row of rows) {
        const recordType = String(row.record_type) as MaterializationLease["recordType"];
        const recordId = String(row.record_id);
        update.run(owner, leaseUntil, now, recordType, recordId);
        const selected = select.get(recordType, recordId, owner) as SqlRow | undefined;
        if (selected) {
          leased.push({
            recordType,
            recordId,
            attempts: Number(selected.attempts),
            leaseOwner: String(selected.lease_owner),
            leaseUntil: Number(selected.lease_until),
          });
        }
      }
      this.db.exec("COMMIT");
      return leased;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMaterializationRecord(
    lease: Pick<MaterializationLease, "recordType" | "recordId">,
  ): StoredFactRevision | StoredSummaryNode | undefined {
    return lease.recordType === "fact"
      ? this.getFactRevision(lease.recordId)
      : this.getSummaryNode(lease.recordId);
  }

  getSummaryNode(nodeId: string): StoredSummaryNode | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM memory_summary_nodes WHERE node_id = ?")
      .get(normalizeRequired(nodeId, "nodeId")) as SqlRow | undefined;
    return row ? rowToSummary(row) : undefined;
  }

  markMaterialized(lease: MaterializationLease): boolean {
    this.assertOpen();
    return (
      this.db
        .prepare(`
          DELETE FROM memory_materialization_outbox
          WHERE record_type = ? AND record_id = ? AND state = 'leased' AND lease_owner = ?
        `)
        .run(lease.recordType, lease.recordId, lease.leaseOwner).changes > 0
    );
  }

  markMaterializationFailed(options: {
    lease: MaterializationLease;
    error: unknown;
    retryDelayMs?: number;
    maxAttempts?: number;
    now?: number;
  }): "retry" | "dead" | "not-owned" {
    this.assertOpen();
    const now = finiteTimestamp(options.now, Date.now());
    const { lease } = options;
    const row = this.db
      .prepare(`
        SELECT attempts FROM memory_materialization_outbox
        WHERE record_type = ? AND record_id = ? AND state = 'leased' AND lease_owner = ?
      `)
      .get(lease.recordType, lease.recordId, lease.leaseOwner) as SqlRow | undefined;
    if (!row) {
      return "not-owned";
    }
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? DEFAULT_MAX_PROJECTION_ATTEMPTS),
    );
    const state = Number(row.attempts) >= maxAttempts ? "dead" : "retry";
    this.db
      .prepare(`
        UPDATE memory_materialization_outbox
        SET state = ?, lease_owner = NULL, lease_until = NULL, next_attempt_at = ?,
            last_error = ?, updated_at = ?
        WHERE record_type = ? AND record_id = ? AND state = 'leased' AND lease_owner = ?
      `)
      .run(
        state,
        state === "retry" ? now + Math.max(0, Math.floor(options.retryDelayMs ?? 5_000)) : 0,
        String(options.error).slice(0, 2_000),
        now,
        lease.recordType,
        lease.recordId,
        lease.leaseOwner,
      );
    return state;
  }

  getIngestCursor(sourcePath: string): MemoryIngestCursor | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM memory_ingest_cursors WHERE source_path = ?")
      .get(normalizeRequired(sourcePath, "sourcePath")) as SqlRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      sourcePath: String(row.source_path),
      sourceIdentity: String(row.source_identity),
      byteOffset: Number(row.byte_offset),
      lineNumber: Number(row.line_number),
      lastEventId: optionalString(row.last_event_id),
      updatedAt: Number(row.updated_at),
    };
  }

  getSourceCheckpoint(options: {
    sourceKind: string;
    agentId: string;
    sourcePath: string;
  }): MemorySourceCheckpoint | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT * FROM memory_source_checkpoints " +
          "WHERE source_kind = ? AND agent_id = ? AND source_path = ?",
      )
      .get(
        normalizeRequired(options.sourceKind, "sourceKind"),
        normalizeRequired(options.agentId, "agentId"),
        normalizeRequired(options.sourcePath, "sourcePath"),
      ) as SqlRow | undefined;
    return row ? rowToSourceCheckpoint(row) : undefined;
  }

  listSourceCheckpoints(options: {
    sourceKind: string;
    agentId?: string;
  }): MemorySourceCheckpoint[] {
    this.assertOpen();
    const sourceKind = normalizeRequired(options.sourceKind, "sourceKind");
    const rows = options.agentId
      ? (this.db
          .prepare(
            "SELECT * FROM memory_source_checkpoints " +
              "WHERE source_kind = ? AND agent_id = ? ORDER BY source_path",
          )
          .all(sourceKind, normalizeRequired(options.agentId, "agentId")) as SqlRow[])
      : (this.db
          .prepare(
            "SELECT * FROM memory_source_checkpoints " +
              "WHERE source_kind = ? ORDER BY agent_id, source_path",
          )
          .all(sourceKind) as SqlRow[]);
    return rows.map(rowToSourceCheckpoint);
  }

  upsertSourceCheckpoint(
    checkpoint: Omit<MemorySourceCheckpoint, "updatedAt"> & { updatedAt?: number },
  ): void {
    this.assertOpen();
    const updatedAt = finiteTimestamp(checkpoint.updatedAt, Date.now());
    this.db
      .prepare(`
        INSERT INTO memory_source_checkpoints(
          source_kind, agent_id, workspace_dir, source_path, source_identity, size_bytes, mtime_ms,
          content_sha256, event_ids_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_kind, agent_id, source_path) DO UPDATE SET
          workspace_dir = excluded.workspace_dir,
          source_identity = excluded.source_identity,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          content_sha256 = excluded.content_sha256,
          event_ids_json = excluded.event_ids_json,
          updated_at = excluded.updated_at
      `)
      .run(
        normalizeRequired(checkpoint.sourceKind, "sourceKind"),
        normalizeRequired(checkpoint.agentId, "agentId"),
        normalizeRequired(checkpoint.workspaceDir, "workspaceDir"),
        normalizeRequired(checkpoint.sourcePath, "sourcePath"),
        normalizeRequired(checkpoint.sourceIdentity, "sourceIdentity"),
        Math.max(0, Math.floor(checkpoint.sizeBytes)),
        Math.max(0, checkpoint.mtimeMs),
        normalizeRequired(checkpoint.contentSha256, "contentSha256"),
        JSON.stringify([
          ...new Set(checkpoint.eventIds.map((id) => normalizeRequired(id, "eventId"))),
        ]),
        updatedAt,
      );
  }

  deleteSourceCheckpoint(options: {
    sourceKind: string;
    agentId: string;
    sourcePath: string;
  }): boolean {
    this.assertOpen();
    return (
      this.db
        .prepare(
          "DELETE FROM memory_source_checkpoints " +
            "WHERE source_kind = ? AND agent_id = ? AND source_path = ?",
        )
        .run(
          normalizeRequired(options.sourceKind, "sourceKind"),
          normalizeRequired(options.agentId, "agentId"),
          normalizeRequired(options.sourcePath, "sourcePath"),
        ).changes > 0
    );
  }

  listRecentEvents(options: { agentId: string; limit?: number }): StoredMemoryEvent[] {
    this.assertOpen();
    const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit ?? 50)));
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_events
        WHERE agent_id = ? AND deleted_at IS NULL
        ORDER BY observed_at DESC, event_id DESC LIMIT ?
      `)
      .all(normalizeRequired(options.agentId, "agentId"), limit) as SqlRow[];
    return rows.map(rowToEvent);
  }

  getMetadata(key: string): string | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT value FROM memory_metadata WHERE key = ?")
      .get(normalizeRequired(key, "key")) as SqlRow | undefined;
    return row ? String(row.value) : undefined;
  }

  setMetadata(key: string, value: string): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO memory_metadata(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(normalizeRequired(key, "key"), value);
  }

  updateIngestCursor(cursor: Omit<MemoryIngestCursor, "updatedAt"> & { updatedAt?: number }): void {
    this.assertOpen();
    const updatedAt = finiteTimestamp(cursor.updatedAt, Date.now());
    this.db
      .prepare(`
        INSERT INTO memory_ingest_cursors(
          source_path, source_identity, byte_offset, line_number, last_event_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
          source_identity = excluded.source_identity,
          byte_offset = excluded.byte_offset,
          line_number = excluded.line_number,
          last_event_id = excluded.last_event_id,
          updated_at = excluded.updated_at
      `)
      .run(
        normalizeRequired(cursor.sourcePath, "sourcePath"),
        normalizeRequired(cursor.sourceIdentity, "sourceIdentity"),
        Math.max(0, Math.floor(cursor.byteOffset)),
        Math.max(0, Math.floor(cursor.lineNumber)),
        normalizeOptional(cursor.lastEventId) ?? null,
        updatedAt,
      );
  }

  getStats(): TemporalLedgerStats {
    this.assertOpen();
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as SqlRow;
      return Number(row.value);
    };
    return {
      events: scalar("SELECT COUNT(*) AS value FROM memory_events"),
      pendingProjection: scalar(
        "SELECT COUNT(*) AS value FROM memory_projection_outbox WHERE state = 'pending'",
      ),
      leasedProjection: scalar(
        "SELECT COUNT(*) AS value FROM memory_projection_outbox WHERE state = 'leased'",
      ),
      retryProjection: scalar(
        "SELECT COUNT(*) AS value FROM memory_projection_outbox WHERE state = 'retry'",
      ),
      deadProjection: scalar(
        "SELECT COUNT(*) AS value FROM memory_projection_outbox WHERE state = 'dead'",
      ),
      factRevisions: scalar("SELECT COUNT(*) AS value FROM memory_fact_revisions"),
      activeFacts: scalar(
        "SELECT COUNT(*) AS value FROM memory_fact_revisions " +
          "WHERE status = 'active' AND system_to IS NULL",
      ),
      dirtySummaries: scalar("SELECT COUNT(*) AS value FROM memory_summary_nodes WHERE dirty = 1"),
      pendingExtraction: scalar(
        "SELECT COUNT(*) AS value FROM memory_fact_extraction_outbox " +
          "WHERE state IN ('pending', 'leased', 'retry')",
      ),
      deadExtraction: scalar(
        "SELECT COUNT(*) AS value FROM memory_fact_extraction_outbox WHERE state = 'dead'",
      ),
      pendingMaterialization: scalar(
        "SELECT COUNT(*) AS value FROM memory_materialization_outbox " +
          "WHERE state IN ('pending', 'leased', 'retry')",
      ),
    };
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    this.assertOpen();
    this.db.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  verifyIntegrity(): { ok: boolean; messages: string[] } {
    this.assertOpen();
    const rows = this.db.prepare("PRAGMA quick_check").all() as SqlRow[];
    const messages = rows.map((row) => String(row.quick_check ?? Object.values(row)[0]));
    return { ok: messages.length === 1 && messages[0] === "ok", messages };
  }

  createSnapshot(destination: string): void {
    this.assertOpen();
    const target = normalizeRequired(destination, "destination");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.checkpoint("PASSIVE");
    this.db.exec(`VACUUM INTO ${sqlLiteral(target)}`);
    try {
      chmodSync(target, 0o600);
    } catch {
      // Best effort on platforms without POSIX mode semantics.
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.checkpoint("TRUNCATE");
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("memory ledger is closed");
    }
  }
}
