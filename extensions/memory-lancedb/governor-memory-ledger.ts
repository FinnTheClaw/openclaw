import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  MemoryGovernorFact,
  MemoryGovernorRetirementDecision,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  normalizeGovernorFact,
  parseGovernorFact,
  type GovernorLedgerSqlRow,
} from "./governor-memory-ledger-codec.js";
import { listCurrentGovernorFacts } from "./governor-memory-ledger-recall.js";
import {
  listPendingGovernorRemediations,
  markGovernorRemediationCompleted,
  type PendingGovernorRemediation,
} from "./governor-memory-ledger-replay.js";
import { compactGovernorMemoryLedger } from "./governor-memory-ledger-retention.js";
import { retireGovernorMemoryFact } from "./governor-memory-ledger-retirement.js";
import { initializeGovernorMemoryLedgerSchema } from "./governor-memory-ledger-schema.js";
import {
  insertGovernorFact,
  retireGovernorFact,
  upsertGovernorRemediation,
} from "./governor-memory-ledger-writes.js";
import {
  assertNoGovernorLineageCycle,
  findGovernorLineageDescendants,
} from "./governor-memory-lineage.js";

type SqlRow = GovernorLedgerSqlRow;
type Optional<T> = T | undefined;
const LEDGER_OWNER = "governor-memory";

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

export class GovernorMemoryLedger {
  readonly #db: DatabaseSync;
  readonly #enqueueProjection: boolean;
  readonly #authorityBindingKey?: string;
  #closed = false;

  constructor(
    readonly path: string,
    options: { enqueueProjection?: boolean; authorityBindingKey?: string } = {},
  ) {
    this.#enqueueProjection = options.enqueueProjection === true;
    this.#authorityBindingKey = options.authorityBindingKey;
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    initializeGovernorMemoryLedgerSchema(this.#db);
  }

  current(agentId: string, scope: string, factKey: string): Optional<MemoryGovernorFact> {
    const row = this.#db
      .prepare(
        "SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope = ? AND fact_key = ? " +
          "AND status = 'active' AND system_to IS NULL ORDER BY observed_at DESC LIMIT 1",
      )
      .get(agentId, scope, factKey) as SqlRow | undefined;
    return row ? parseGovernorFact(row, this.#authorityBindingKey) : undefined;
  }

  highWater(agentId: string, scope: string, factKey: string): SqlRow | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM memory_governor_high_water WHERE agent_id = ? AND scope = ? AND fact_key = ?",
      )
      .get(agentId, scope, factKey) as SqlRow | undefined;
  }

  admit(fact: MemoryGovernorFact, now: number): GovernorLedgerResult {
    const normalized = normalizeGovernorFact(fact, this.#authorityBindingKey);
    const remediationId = `gov-remediation-${digest(
      LEDGER_OWNER,
      normalized.scopeKey,
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
        .get(LEDGER_OWNER, normalized.scopeKey, normalized.factKey) as SqlRow | undefined;
      const current = currentRow ? this.#parse(currentRow) : undefined;
      const highWater = this.highWater(LEDGER_OWNER, normalized.scopeKey, normalized.factKey);
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
      const priorGeneration = Number(highWater?.generation ?? 0);
      if (highWater && normalized.generation <= priorGeneration) {
        this.#db.exec("ROLLBACK");
        return { status: "rejected", reason: "authority_generation_not_monotonic", remediationId };
      }
      const generation = normalized.generation;
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
      const admittedFact = normalized;
      insertGovernorFact(this.#db, admittedFact, now, this.#enqueueProjection);
      this.#db
        .prepare(
          "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at) " +
            "VALUES(?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
            "generation = excluded.generation, status = excluded.status, revision_id = excluded.revision_id, " +
            "source_evidence_digest = excluded.source_evidence_digest, observed_at = excluded.observed_at, updated_at = excluded.updated_at, " +
            "retirement_decision_id = NULL, retirement_binding_digest = NULL, retirement_reason = NULL, authority_key_id = NULL",
        )
        .run(
          LEDGER_OWNER,
          normalized.scopeKey,
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
    scopeKey: string;
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
      params.scopeKey,
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
        .get(params.staleMemoryId, params.agentId, params.scopeKey, params.factKey) as
        | SqlRow
        | undefined;
      const stale = staleRow ? this.#parse(staleRow) : undefined;
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
      const replacement = params.replacement
        ? normalizeGovernorFact(params.replacement, this.#authorityBindingKey)
        : undefined;
      const descendants = findGovernorLineageDescendants(
        this.#db,
        params.staleMemoryId,
        params.scopeKey,
        [stale.sourceEvidenceId, params.sourceEvidenceId],
      );
      const impactedRows = descendants.length
        ? (this.#db
            .prepare(
              `SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope = ? AND status = 'active' AND system_to IS NULL AND revision_id IN (${[...descendants].map(() => "?").join(", ")})`,
            )
            .all(params.agentId, params.scopeKey, ...descendants) as SqlRow[])
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
      const highWater = this.highWater(params.agentId, params.scopeKey, params.factKey);
      const nextGeneration = Number(highWater?.generation ?? 0) + 1;
      if (replacement) {
        if (
          replacement.scopeKey !== params.scopeKey ||
          replacement.factKey !== params.factKey ||
          replacement.observedAt <= stale.observedAt
        ) {
          throw new Error("GOVERNOR_MEMORY_REPLACEMENT_BINDING_INVALID");
        }
        if (replacement.generation <= Number(highWater?.generation ?? stale.generation)) {
          throw new Error("GOVERNOR_MEMORY_REPLACEMENT_GENERATION_INVALID");
        }
        replacementMemoryId = replacement.memoryId;
        replacementFact = replacement;
      }
      const replacementGeneration = replacement?.generation ?? nextGeneration;
      if (replacement) {
        insertGovernorFact(this.#db, replacement, params.now, this.#enqueueProjection);
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
          params.scopeKey,
          params.factKey,
          replacementGeneration,
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
        const fact = this.#parse(row);
        if (!fact) {
          continue;
        }
        const dependentHighWater = this.highWater(LEDGER_OWNER, fact.scopeKey, fact.factKey);
        this.#db
          .prepare(
            "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at) " +
              "VALUES(?, ?, ?, ?, 'tombstone', NULL, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
              "generation = excluded.generation, status = 'tombstone', revision_id = NULL, source_evidence_digest = excluded.source_evidence_digest, " +
              "observed_at = excluded.observed_at, updated_at = excluded.updated_at",
          )
          .run(
            LEDGER_OWNER,
            fact.scopeKey,
            fact.factKey,
            Number(dependentHighWater?.generation ?? 0) + 1,
            params.sourceEvidenceDigest,
            params.sourceObservedAt,
            params.now,
          );
        upsertGovernorRemediation({
          db: this.#db,
          remediationId: `gov-remediation-${digest(LEDGER_OWNER, fact.scopeKey, fact.factKey, params.sourceEvidenceDigest)}`,
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

  retire(decision: MemoryGovernorRetirementDecision): {
    status: "retired" | "duplicate";
    staleMemoryId: string;
    remediationId: string;
  } {
    return retireGovernorMemoryFact({
      db: this.#db,
      authorityBindingKey: this.#authorityBindingKey,
      decision,
      parse: (row) => this.#parse(row),
    });
  }

  listCurrent(agentId: string, scopes: readonly string[], now: number): MemoryGovernorFact[] {
    return listCurrentGovernorFacts(this.#db, agentId, scopes, now, (row) => this.#parse(row));
  }

  pendingRemediations(agentId = LEDGER_OWNER, limit = 256): PendingGovernorRemediation[] {
    return listPendingGovernorRemediations(
      this.#db,
      (row) => this.#parse(row),
      agentId,
      Math.min(256, Math.max(1, Math.floor(limit))),
    );
  }

  markRemediationCompleted(remediationId: string, now: number): void {
    markGovernorRemediationCompleted(this.#db, remediationId, now);
  }

  compact(params: { agentId?: string; now: number; retentionMs: number }) {
    return compactGovernorMemoryLedger(this.#db, params);
  }

  #parse(row: SqlRow): Optional<MemoryGovernorFact> {
    return parseGovernorFact(row, this.#authorityBindingKey);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      this.#db.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      this.#db.close();
    }
  }
}
