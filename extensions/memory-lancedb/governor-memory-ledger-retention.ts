import type { DatabaseSync } from "node:sqlite";

export function compactGovernorMemoryLedger(
  db: DatabaseSync,
  params: { agentId?: string; now: number; retentionMs: number },
): { compacted: number; retainedHighWater: number; compactedMemoryIds: readonly string[] } {
  const cutoff = params.now - Math.max(60_000, params.retentionMs);
  const expiredMemoryIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const expired = db
      .prepare(
        "SELECT revision_id, valid_to FROM memory_fact_revisions WHERE status = 'active' " +
          "AND valid_to IS NOT NULL AND valid_to < ? AND (? IS NULL OR agent_id = ?) LIMIT 256",
      )
      .all(params.now, params.agentId ?? null, params.agentId ?? null) as Array<
      Record<string, unknown>
    >;
    for (const row of expired) {
      const revisionId = String(row.revision_id);
      expiredMemoryIds.push(revisionId);
      db.prepare(
        "UPDATE memory_fact_revisions SET status = 'retracted', system_to = ? WHERE revision_id = ? AND status = 'active'",
      ).run(Number(row.valid_to), revisionId);
      db.prepare(
        "UPDATE memory_governor_high_water SET status = 'tombstone', revision_id = NULL, " +
          "generation = generation + 1, observed_at = MAX(observed_at, ?), updated_at = ? " +
          "WHERE revision_id = ?",
      ).run(Number(row.valid_to), params.now, revisionId);
      db.prepare(
        "INSERT INTO memory_materialization_outbox(record_type, record_id, state, updated_at) VALUES('fact', ?, 'pending', ?) " +
          "ON CONFLICT(record_type, record_id) DO UPDATE SET state = 'pending', lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at",
      ).run(revisionId, params.now);
    }
    const rows = db
      .prepare(
        "SELECT revision_id, source_event_id FROM memory_fact_revisions WHERE status != 'active' " +
          "AND system_to IS NOT NULL AND system_to < ? AND (? IS NULL OR agent_id = ?) " +
          "ORDER BY system_to ASC LIMIT 256",
      )
      .all(cutoff, params.agentId ?? null, params.agentId ?? null) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const revisionId = String(row.revision_id);
      db.prepare("DELETE FROM memory_fact_evidence WHERE revision_id = ?").run(revisionId);
      db.prepare("DELETE FROM memory_governor_lineage WHERE memory_id = ?").run(revisionId);
      db.prepare(
        "UPDATE memory_fact_revisions SET supersedes_revision_id = NULL WHERE supersedes_revision_id = ?",
      ).run(revisionId);
      db.prepare("DELETE FROM memory_fact_revisions WHERE revision_id = ?").run(revisionId);
      if (typeof row.source_event_id === "string" && row.source_event_id) {
        db.prepare(
          "UPDATE memory_events SET content = '[compacted]', metadata_json = '{\"governor\":{\"compacted\":true}}', content_sha256 = '[compacted]' WHERE event_id = ?",
        ).run(row.source_event_id);
      }
    }
    const remediationRows = db
      .prepare(
        "SELECT remediation_id FROM memory_governor_remediations WHERE state = 'completed' AND updated_at < ? " +
          "AND (? IS NULL OR agent_id = ?) ORDER BY updated_at ASC LIMIT 256",
      )
      .all(cutoff, params.agentId ?? null, params.agentId ?? null) as Array<
      Record<string, unknown>
    >;
    for (const row of remediationRows) {
      db.prepare("DELETE FROM memory_governor_remediations WHERE remediation_id = ?").run(
        String(row.remediation_id),
      );
    }
    // Keep one compact anti-rollback summary per canonical identity.  This is
    // bounded by identity cardinality and is the durable fence that prevents
    // an old source from returning after payload compaction and restart.
    db.exec("COMMIT");
    const highWater = db
      .prepare("SELECT COUNT(*) AS count FROM memory_governor_high_water")
      .get() as Record<string, unknown>;
    return {
      compacted: rows.length,
      retainedHighWater: Number(highWater.count),
      compactedMemoryIds: [
        ...new Set([...expiredMemoryIds, ...rows.map((row) => String(row.revision_id))]),
      ],
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
