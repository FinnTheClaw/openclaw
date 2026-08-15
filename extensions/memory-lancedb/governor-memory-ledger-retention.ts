import type { DatabaseSync } from "node:sqlite";

export function compactGovernorMemoryLedger(
  db: DatabaseSync,
  params: { agentId?: string; now: number; retentionMs: number },
): { compacted: number; retainedHighWater: number; compactedMemoryIds: readonly string[] } {
  const cutoff = params.now - Math.max(60_000, params.retentionMs);
  db.exec("BEGIN IMMEDIATE");
  try {
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
        db.prepare("UPDATE memory_events SET content = '[compacted]' WHERE event_id = ?").run(
          row.source_event_id,
        );
      }
    }
    const remediationRows = db
      .prepare(
        "SELECT remediation_id FROM memory_governor_remediations WHERE updated_at < ? " +
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
    db.exec("COMMIT");
    const highWater = db
      .prepare("SELECT COUNT(*) AS count FROM memory_governor_high_water")
      .get() as Record<string, unknown>;
    return {
      compacted: rows.length,
      retainedHighWater: Number(highWater.count),
      compactedMemoryIds: rows.map((row) => String(row.revision_id)),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
