import type { DatabaseSync } from "node:sqlite";
import {
  type MemoryGovernorFact,
  type MemoryGovernorRetirementDecision,
  verifyGovernorMemoryRetirementDecision,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { retireGovernorFact, upsertGovernorRemediation } from "./governor-memory-ledger-writes.js";

type SqlRow = Record<string, unknown>;
const LEDGER_OWNER = "governor-memory";

export function retireGovernorMemoryFact(params: {
  db: DatabaseSync;
  authorityBindingKey?: string;
  decision: MemoryGovernorRetirementDecision;
  parse(row: SqlRow): MemoryGovernorFact | undefined;
}): { status: "retired" | "duplicate"; staleMemoryId: string; remediationId: string } {
  const { db, decision } = params;
  if (
    !params.authorityBindingKey ||
    !verifyGovernorMemoryRetirementDecision(decision, params.authorityBindingKey)
  ) {
    throw new Error("GOVERNOR_MEMORY_RETIREMENT_DECISION_INVALID");
  }
  const remediationId = `gov-remediation-${decision.decisionId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const highWater = db
      .prepare(
        "SELECT * FROM memory_governor_high_water WHERE agent_id = ? AND scope = ? AND fact_key = ?",
      )
      .get(LEDGER_OWNER, decision.scopeKey, decision.factKey) as SqlRow | undefined;
    const row = db
      .prepare(
        "SELECT * FROM memory_fact_revisions WHERE revision_id = ? AND agent_id = ? AND scope = ? " +
          "AND fact_key = ? AND status = 'active' AND system_to IS NULL",
      )
      .get(decision.staleMemoryId, LEDGER_OWNER, decision.scopeKey, decision.factKey) as
      | SqlRow
      | undefined;
    const fact = row ? params.parse(row) : undefined;
    if (!row || !fact) {
      if (
        highWater?.status === "tombstone" &&
        Number(highWater.generation) === decision.newGeneration &&
        Number(highWater.observed_at) === decision.semanticCutoff &&
        highWater.retirement_decision_id === decision.decisionId &&
        highWater.retirement_binding_digest === decision.retirementBindingDigest &&
        highWater.retirement_reason === decision.reason &&
        highWater.authority_key_id === decision.authorityKeyId
      ) {
        db.exec("COMMIT");
        return { status: "duplicate", staleMemoryId: decision.staleMemoryId, remediationId };
      }
      throw new Error("GOVERNOR_MEMORY_RETIREMENT_STALE_BINDING");
    }
    if (
      highWater?.status !== "active" ||
      Number(highWater.generation) !== decision.priorGeneration ||
      fact.generation !== decision.priorGeneration ||
      fact.authorityBindingDigest !== decision.priorAuthorityBindingDigest
    ) {
      throw new Error("GOVERNOR_MEMORY_RETIREMENT_STALE_BINDING");
    }
    retireGovernorFact(db, row, decision.issuedAt, "retracted");
    db.prepare(
      "INSERT INTO memory_governor_high_water(agent_id, scope, fact_key, generation, status, revision_id, source_evidence_digest, observed_at, updated_at, retirement_decision_id, retirement_binding_digest, retirement_reason, authority_key_id) " +
        "VALUES(?, ?, ?, ?, 'tombstone', NULL, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, scope, fact_key) DO UPDATE SET " +
        "generation = excluded.generation, status = 'tombstone', revision_id = NULL, source_evidence_digest = excluded.source_evidence_digest, " +
        "observed_at = excluded.observed_at, updated_at = excluded.updated_at, retirement_decision_id = excluded.retirement_decision_id, " +
        "retirement_binding_digest = excluded.retirement_binding_digest, retirement_reason = excluded.retirement_reason, authority_key_id = excluded.authority_key_id",
    ).run(
      LEDGER_OWNER,
      decision.scopeKey,
      decision.factKey,
      decision.newGeneration,
      fact.sourceEvidenceDigest,
      decision.semanticCutoff,
      decision.issuedAt,
      decision.decisionId,
      decision.retirementBindingDigest,
      decision.reason,
      decision.authorityKeyId,
    );
    upsertGovernorRemediation({
      db,
      remediationId,
      fact,
      staleRevisionId: fact.memoryId,
      reason: decision.reason,
      now: decision.issuedAt,
    });
    db.exec("COMMIT");
    return { status: "retired", staleMemoryId: fact.memoryId, remediationId };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the primary failure.
    }
    throw error;
  }
}
