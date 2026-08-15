import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { listCurrentGovernorFacts } from "./governor-memory-ledger-recall.js";
import { compactGovernorMemoryLedger } from "./governor-memory-ledger-retention.js";
import {
  insertGovernorFact,
  retireGovernorFact,
  upsertGovernorRemediation,
} from "./governor-memory-ledger-writes.js";
import {
  assertNoGovernorLineageCycle,
  findGovernorLineageDescendants,
} from "./governor-memory-lineage.js";
import { assertMemoryContentSafe } from "./memory-content-guard.js";

type SqlRow = Record<string, unknown>;
type Optional<T> = T | undefined;

export type GovernorLedgerResult = {
  status: "admitted" | "duplicate" | "rejected";
  fact?: MemoryGovernorFact;
  reason?: string;
  remediationId: string;
  staleRevisionId?: string;
};

export type GovernorLedgerInvalidation = {
  status: "retired" | "duplicate" | "tombstoned";
  staleMemoryId: string;
  invalidatedMemoryIds: readonly string[];
  replacementMemoryId?: string;
  replacementFact?: MemoryGovernorFact;
  remediationId: string;
};

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function text(value: string, label: string, max = 4096): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return normalized;
}

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`governor memory ${label} must be between 0 and 1`);
  }
  return value;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return value;
}

function lineage(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return [...new Set(value.map((item) => text(item, label, 256)))];
}

function normalizeFact(fact: MemoryGovernorFact): MemoryGovernorFact {
  const normalized: MemoryGovernorFact = {
    ...fact,
    memoryId: text(fact.memoryId, "memoryId", 256),
    agentId: text(fact.agentId, "agentId", 256),
    scope: text(fact.scope, "scope", 512),
    factKey: text(fact.factKey, "factKey", 256),
    subject: text(fact.subject, "subject", 256),
    predicate: text(fact.predicate, "predicate", 256),
    object: text(fact.object, "object", 2048),
    text: text(fact.text, "text", 4096),
    sourceIdentity: text(fact.sourceIdentity, "sourceIdentity", 512),
    sourceEvidenceId: text(fact.sourceEvidenceId, "sourceEvidenceId", 512),
    sourceEvidenceDigest: text(fact.sourceEvidenceDigest, "sourceEvidenceDigest", 256),
    confidence: unit(fact.confidence, "confidence"),
    authority: unit(fact.authority, "authority"),
    observedAt: timestamp(fact.observedAt, "observedAt"),
    ...(fact.freshnessExpiresAt === undefined
      ? {}
      : { freshnessExpiresAt: timestamp(fact.freshnessExpiresAt, "freshnessExpiresAt") }),
    sourceEvidenceLineage: lineage(fact.sourceEvidenceLineage, "sourceEvidenceLineage"),
    sourceMemoryLineage: lineage(fact.sourceMemoryLineage, "sourceMemoryLineage"),
  };
  if (
    normalized.freshnessExpiresAt !== undefined &&
    normalized.freshnessExpiresAt < normalized.observedAt
  ) {
    throw new Error("governor memory freshnessExpiresAt is older than observedAt");
  }
  assertMemoryContentSafe(normalized.text);
  return normalized;
}

function parseGovernorFact(row: SqlRow): Optional<MemoryGovernorFact> {
  try {
    const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    const governor = metadata.governor;
    if (!governor || typeof governor !== "object" || Array.isArray(governor)) {
      return undefined;
    }
    const value = governor as Record<string, unknown>;
    return {
      memoryId: String(row.revision_id),
      agentId: String(row.agent_id),
      scope: String(row.scope),
      factKey: String(row.fact_key),
      subject: String(row.subject),
      predicate: String(row.predicate),
      object: String(row.object_value),
      text: String(row.text),
      category: String(row.category),
      confidence: Number(row.confidence),
      authority: Number(row.authority),
      ...(value.generation === undefined ? {} : { generation: Number(value.generation) }),
      observedAt: Number(row.observed_at),
      ...(value.freshnessExpiresAt === undefined
        ? {}
        : { freshnessExpiresAt: Number(value.freshnessExpiresAt) }),
      sourceIdentity: String(value.sourceIdentity),
      sourceEvidenceId: String(value.sourceEvidenceId),
      sourceEvidenceDigest: String(value.sourceEvidenceDigest),
      ...(typeof value.sourceEvidenceSemanticDigest === "string"
        ? { sourceEvidenceSemanticDigest: value.sourceEvidenceSemanticDigest }
        : {}),
      ...(Array.isArray(value.sourceEvidenceLineage)
        ? { sourceEvidenceLineage: value.sourceEvidenceLineage.map(String) }
        : {}),
      ...(Array.isArray(value.sourceMemoryLineage)
        ? { sourceMemoryLineage: value.sourceMemoryLineage.map(String) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export class GovernorMemoryLedger {
  readonly #db: DatabaseSync;
  readonly #enqueueProjection: boolean;

  constructor(
    readonly path: string,
    options: { enqueueProjection?: boolean } = {},
  ) {
    this.#enqueueProjection = options.enqueueProjection === true;
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory_governor_high_water (
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'tombstone')),
        revision_id TEXT,
        source_evidence_digest TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, scope, fact_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_governor_remediations (
        remediation_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        stale_revision_id TEXT NOT NULL,
        replacement_revision_id TEXT,
        source_evidence_id TEXT NOT NULL,
        source_evidence_digest TEXT NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('completed', 'pending')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_governor_remediation_ready
        ON memory_governor_remediations(state, updated_at);
      CREATE TABLE IF NOT EXISTS memory_governor_lineage (
        memory_id TEXT NOT NULL,
        source_memory_id TEXT,
        source_evidence_id TEXT NOT NULL,
        PRIMARY KEY(memory_id, source_memory_id, source_evidence_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_governor_lineage_source
        ON memory_governor_lineage(source_evidence_id, memory_id);
    `);
    try {
      this.#db.exec("ALTER TABLE memory_governor_lineage ADD COLUMN source_memory_id TEXT");
    } catch {
      // Existing v1 lineage already has the required evidence rows.
    }
  }

  current(agentId: string, scope: string, factKey: string): Optional<MemoryGovernorFact> {
    const row = this.#db
      .prepare(
        "SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope = ? AND fact_key = ? " +
          "AND status = 'active' AND system_to IS NULL ORDER BY observed_at DESC LIMIT 1",
      )
      .get(agentId, scope, factKey) as SqlRow | undefined;
    return row ? parseGovernorFact(row) : undefined;
  }

  highWater(agentId: string, scope: string, factKey: string): SqlRow | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM memory_governor_high_water WHERE agent_id = ? AND scope = ? AND fact_key = ?",
      )
      .get(agentId, scope, factKey) as SqlRow | undefined;
  }

  admit(fact: MemoryGovernorFact, now: number): GovernorLedgerResult {
    const normalized = normalizeFact(fact);
    const remediationId = `gov-remediation-${digest(
      normalized.agentId,
      normalized.scope,
      normalized.factKey,
      normalized.sourceEvidenceDigest,
    )}`;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertNoGovernorLineageCycle(
        this.#db,
        normalized.memoryId,
        normalized.sourceMemoryLineage ?? [],
      );
      const currentRow = this.#db
        .prepare(
          "SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope = ? AND fact_key = ? " +
            "AND status = 'active' AND system_to IS NULL LIMIT 1",
        )
        .get(normalized.agentId, normalized.scope, normalized.factKey) as SqlRow | undefined;
      const current = currentRow ? parseGovernorFact(currentRow) : undefined;
      const highWater = this.highWater(normalized.agentId, normalized.scope, normalized.factKey);
      if (
        current &&
        current.sourceEvidenceDigest === normalized.sourceEvidenceDigest &&
        current.text === normalized.text
      ) {
        this.#db.exec("COMMIT");
        return { status: "duplicate", fact: current, remediationId };
      }
      if (currentRow && !current) {
        this.#db.exec("ROLLBACK");
        return { status: "rejected", reason: "existing_fact_not_governed", remediationId };
      }
      const priorObservedAt = Math.max(
        current?.observedAt ?? 0,
        Number(highWater?.observed_at ?? 0),
      );
      const generation = Number(highWater?.generation ?? 0) + 1;
      if (
        normalized.observedAt <= priorObservedAt ||
        (current && normalized.authority < current.authority)
      ) {
        this.#db.exec("ROLLBACK");
        return { status: "rejected", reason: "older_or_weaker_evidence", remediationId };
      }
      if (currentRow) {
        retireGovernorFact(this.#db, currentRow, now, "superseded");
      }
      const admittedFact = { ...normalized, generation };
      insertGovernorFact(this.#db, admittedFact, now, this.#enqueueProjection);
      this.#db
        .prepare(
          "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at) " +
            "VALUES(?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
            "generation = excluded.generation, status = excluded.status, revision_id = excluded.revision_id, " +
            "source_evidence_digest = excluded.source_evidence_digest, observed_at = excluded.observed_at, updated_at = excluded.updated_at",
        )
        .run(
          normalized.agentId,
          normalized.scope,
          normalized.factKey,
          generation,
          admittedFact.memoryId,
          admittedFact.sourceEvidenceDigest,
          admittedFact.observedAt,
          now,
        );
      if (current) {
        upsertGovernorRemediation({
          db: this.#db,
          remediationId,
          fact: normalized,
          staleRevisionId: current.memoryId,
          reason: "verified_admission",
          now,
        });
      }
      this.#db.exec("COMMIT");
      return {
        status: "admitted",
        fact: admittedFact,
        remediationId,
        ...(current ? { staleRevisionId: current.memoryId } : {}),
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  invalidate(params: {
    agentId: string;
    scope: string;
    factKey: string;
    staleMemoryId: string;
    sourceEvidenceId: string;
    sourceEvidenceDigest: string;
    sourceObservedAt: number;
    reason: string;
    replacement?: MemoryGovernorFact;
    now: number;
  }): GovernorLedgerInvalidation {
    const remediationId = `gov-remediation-${digest(
      params.agentId,
      params.scope,
      params.factKey,
      params.sourceEvidenceDigest,
    )}`;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare("SELECT * FROM memory_governor_remediations WHERE remediation_id = ?")
        .get(remediationId) as SqlRow | undefined;
      if (existing) {
        this.#db.exec("COMMIT");
        return {
          status: "duplicate",
          staleMemoryId: params.staleMemoryId,
          invalidatedMemoryIds: [params.staleMemoryId],
          ...(typeof existing.replacement_revision_id === "string"
            ? { replacementMemoryId: existing.replacement_revision_id }
            : {}),
          remediationId,
        };
      }
      const staleRow = this.#db
        .prepare(
          "SELECT * FROM memory_fact_revisions WHERE revision_id = ? AND agent_id = ? AND scope = ? " +
            "AND fact_key = ? AND status = 'active' AND system_to IS NULL",
        )
        .get(params.staleMemoryId, params.agentId, params.scope, params.factKey) as
        | SqlRow
        | undefined;
      const stale = staleRow ? parseGovernorFact(staleRow) : undefined;
      if (!staleRow || !stale) {
        this.#db.exec("ROLLBACK");
        throw new Error("GOVERNOR_MEMORY_STALE_BINDING_INVALID");
      }
      if (
        params.sourceObservedAt <= stale.observedAt ||
        params.sourceEvidenceDigest === stale.sourceEvidenceDigest
      ) {
        this.#db.exec("ROLLBACK");
        throw new Error("GOVERNOR_MEMORY_INVALIDATION_NOT_NEWER");
      }
      const replacement = params.replacement ? normalizeFact(params.replacement) : undefined;
      const descendants = findGovernorLineageDescendants(this.#db, params.staleMemoryId);
      const impactedRows = descendants.length
        ? (this.#db
            .prepare(
              `SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope = ? AND status = 'active' AND system_to IS NULL AND revision_id IN (${[...descendants].map(() => "?").join(", ")})`,
            )
            .all(params.agentId, params.scope, ...descendants) as SqlRow[])
        : [];
      const impacted = impactedRows.some((row) => String(row.revision_id) === params.staleMemoryId)
        ? impactedRows
        : [staleRow, ...impactedRows];
      for (const row of impacted) {
        retireGovernorFact(
          this.#db,
          row,
          params.now,
          String(row.revision_id) === params.staleMemoryId && replacement
            ? "superseded"
            : "retracted",
        );
      }
      let replacementMemoryId: string | undefined;
      let replacementFact: Optional<MemoryGovernorFact>;
      const highWater = this.highWater(params.agentId, params.scope, params.factKey);
      const nextGeneration = Number(highWater?.generation ?? 0) + 1;
      if (replacement) {
        if (
          replacement.agentId !== params.agentId ||
          replacement.scope !== params.scope ||
          replacement.factKey !== params.factKey ||
          replacement.observedAt <= stale.observedAt
        ) {
          throw new Error("GOVERNOR_MEMORY_REPLACEMENT_BINDING_INVALID");
        }
        replacementMemoryId = replacement.memoryId;
        replacementFact = { ...replacement, generation: nextGeneration };
        insertGovernorFact(this.#db, replacementFact, params.now, this.#enqueueProjection);
      }
      this.#db
        .prepare(
          "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at) " +
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
            "generation = excluded.generation, status = excluded.status, revision_id = excluded.revision_id, " +
            "source_evidence_digest = excluded.source_evidence_digest, observed_at = excluded.observed_at, updated_at = excluded.updated_at",
        )
        .run(
          params.agentId,
          params.scope,
          params.factKey,
          nextGeneration,
          replacement ? "active" : "tombstone",
          replacementMemoryId ?? null,
          params.sourceEvidenceDigest,
          params.sourceObservedAt,
          params.now,
        );
      for (const row of impacted) {
        if (String(row.revision_id) === params.staleMemoryId) {
          continue;
        }
        const fact = parseGovernorFact(row);
        if (!fact) {
          continue;
        }
        const dependentHighWater = this.highWater(fact.agentId, fact.scope, fact.factKey);
        this.#db
          .prepare(
            "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at) " +
              "VALUES(?, ?, ?, ?, 'tombstone', NULL, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
              "generation = excluded.generation, status = 'tombstone', revision_id = NULL, source_evidence_digest = excluded.source_evidence_digest, " +
              "observed_at = excluded.observed_at, updated_at = excluded.updated_at",
          )
          .run(
            fact.agentId,
            fact.scope,
            fact.factKey,
            Number(dependentHighWater?.generation ?? 0) + 1,
            params.sourceEvidenceDigest,
            params.sourceObservedAt,
            params.now,
          );
        upsertGovernorRemediation({
          db: this.#db,
          remediationId: `gov-remediation-${digest(fact.agentId, fact.scope, fact.factKey, params.sourceEvidenceDigest)}`,
          fact,
          staleRevisionId: fact.memoryId,
          reason: `dependent_${params.reason}`,
          now: params.now,
          sourceEvidenceId: params.sourceEvidenceId,
          sourceEvidenceDigest: params.sourceEvidenceDigest,
        });
      }
      upsertGovernorRemediation({
        db: this.#db,
        remediationId,
        fact: replacement ?? stale,
        staleRevisionId: stale.memoryId,
        reason: params.reason,
        now: params.now,
        replacementRevisionId: replacementMemoryId,
        sourceEvidenceId: params.sourceEvidenceId,
        sourceEvidenceDigest: params.sourceEvidenceDigest,
      });
      this.#db.exec("COMMIT");
      return {
        status: replacement ? "retired" : "tombstoned",
        staleMemoryId: stale.memoryId,
        invalidatedMemoryIds: impacted.map((row) => String(row.revision_id)),
        ...(replacementMemoryId ? { replacementMemoryId } : {}),
        ...(replacementFact ? { replacementFact } : {}),
        remediationId,
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  listCurrent(agentId: string, scopes: readonly string[], now: number): MemoryGovernorFact[] {
    return listCurrentGovernorFacts(this.#db, agentId, scopes, now, parseGovernorFact);
  }

  compact(params: { agentId?: string; now: number; retentionMs: number }) {
    return compactGovernorMemoryLedger(this.#db, params);
  }

  close(): void {
    this.#db.close();
  }
}
