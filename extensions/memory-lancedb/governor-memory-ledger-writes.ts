import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type SqlRow = Record<string, unknown>;

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? Number(child) : child,
  );
}

export function insertGovernorFact(
  db: DatabaseSync,
  fact: MemoryGovernorFact,
  now: number,
  enqueueProjection = false,
): void {
  const eventId = `governor-evidence-${digest(fact.agentId, fact.scope, fact.factKey, fact.sourceEvidenceDigest)}`;
  db.prepare(
    "INSERT OR IGNORE INTO memory_events(event_id, external_id, agent_id, session_key, channel, conversation_id, role, content, source_kind, source_ref, observed_at, valid_from, valid_to, content_sha256, metadata_json) " +
      "VALUES(?, ?, ?, NULL, NULL, NULL, 'tool', ?, 'governor_verified_evidence', ?, ?, ?, ?, ?, ?)",
  ).run(
    eventId,
    eventId,
    fact.agentId,
    fact.text,
    fact.sourceEvidenceId,
    fact.observedAt,
    fact.observedAt,
    fact.freshnessExpiresAt ?? null,
    digest(fact.text),
    json({ governor: fact, verificationStatus: "verified", retrievalStatus: "active" }),
  );
  db.prepare(
    "INSERT INTO memory_fact_revisions(revision_id, fact_key, agent_id, scope, subject, predicate, object_value, text, category, confidence, authority, valid_from, valid_to, observed_at, system_from, system_to, status, supersedes_revision_id, source_event_id, metadata_json) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, ?, ?)",
  ).run(
    fact.memoryId,
    fact.factKey,
    fact.agentId,
    fact.scope,
    fact.subject,
    fact.predicate,
    fact.object,
    fact.text,
    fact.category ?? "fact",
    fact.confidence,
    fact.authority,
    fact.observedAt,
    fact.freshnessExpiresAt ?? null,
    fact.observedAt,
    now,
    eventId,
    json({ governor: fact, verificationStatus: "verified", retrievalStatus: "active" }),
  );
  db.prepare(
    "INSERT OR IGNORE INTO memory_fact_evidence(revision_id, event_id, observed_at) VALUES(?, ?, ?)",
  ).run(fact.memoryId, eventId, fact.observedAt);
  if (enqueueProjection) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_projection_outbox(event_id, state, updated_at) VALUES(?, 'pending', ?)",
    ).run(eventId, now);
  }
  db.prepare(
    "INSERT OR IGNORE INTO memory_governor_lineage(memory_id, source_memory_id, source_evidence_id) VALUES(?, NULL, ?)",
  ).run(fact.memoryId, fact.sourceEvidenceId);
  for (const sourceEvidenceId of fact.sourceEvidenceLineage ?? []) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_governor_lineage(memory_id, source_memory_id, source_evidence_id) VALUES(?, NULL, ?)",
    ).run(fact.memoryId, sourceEvidenceId);
  }
  for (const sourceMemoryId of fact.sourceMemoryLineage ?? []) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_governor_lineage(memory_id, source_memory_id, source_evidence_id) VALUES(?, ?, ?)",
    ).run(fact.memoryId, sourceMemoryId, fact.sourceEvidenceId);
  }
  db.prepare(
    "INSERT INTO memory_materialization_outbox(record_type, record_id, state, updated_at) VALUES('fact', ?, 'pending', ?) " +
      "ON CONFLICT(record_type, record_id) DO UPDATE SET state = 'pending', lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at",
  ).run(fact.memoryId, now);
}

export function retireGovernorFact(
  db: DatabaseSync,
  row: SqlRow,
  now: number,
  status: "superseded" | "retracted",
): void {
  db.prepare(
    "UPDATE memory_fact_revisions SET status = ?, system_to = ? WHERE revision_id = ? AND status = 'active' AND system_to IS NULL",
  ).run(status, now, String(row.revision_id));
  db.prepare(
    "INSERT INTO memory_materialization_outbox(record_type, record_id, state, updated_at) VALUES('fact', ?, 'pending', ?) " +
      "ON CONFLICT(record_type, record_id) DO UPDATE SET state = 'pending', lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at",
  ).run(String(row.revision_id), now);
}

export function upsertGovernorRemediation(params: {
  db: DatabaseSync;
  remediationId: string;
  fact: MemoryGovernorFact;
  staleRevisionId: string;
  replacementRevisionId?: string;
  reason: string;
  now: number;
  sourceEvidenceId?: string;
  sourceEvidenceDigest?: string;
}): void {
  params.db
    .prepare(
      "INSERT INTO memory_governor_remediations(remediation_id, agent_id, scope, fact_key, stale_revision_id, replacement_revision_id, source_evidence_id, source_evidence_digest, reason, state, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?) ON CONFLICT(remediation_id) DO UPDATE SET replacement_revision_id = excluded.replacement_revision_id, state = 'completed', updated_at = excluded.updated_at",
    )
    .run(
      params.remediationId,
      params.fact.agentId,
      params.fact.scope,
      params.fact.factKey,
      params.staleRevisionId,
      params.replacementRevisionId ?? null,
      params.sourceEvidenceId ?? params.fact.sourceEvidenceId,
      params.sourceEvidenceDigest ?? params.fact.sourceEvidenceDigest,
      params.reason,
      params.now,
    );
}
