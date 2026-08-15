import type { DatabaseSync } from "node:sqlite";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type SqlRow = Record<string, unknown>;

export type PendingGovernorRemediation = {
  remediationId: string;
  staleRevisionId: string;
  replacementFact?: MemoryGovernorFact;
};

export function listPendingGovernorRemediations(
  db: DatabaseSync,
  parse: (row: SqlRow) => unknown,
  agentId: string,
  limit: number,
): PendingGovernorRemediation[] {
  const rows = db
    .prepare(
      "SELECT remediation_id, stale_revision_id, replacement_revision_id FROM memory_governor_remediations " +
        "WHERE agent_id = ? AND state = 'pending' ORDER BY updated_at ASC LIMIT ?",
    )
    .all(agentId, limit) as SqlRow[];
  return rows.map((row) => {
    const replacementId = row.replacement_revision_id;
    const replacementRow =
      typeof replacementId === "string" && replacementId
        ? (db
            .prepare("SELECT * FROM memory_fact_revisions WHERE revision_id = ?")
            .get(replacementId) as SqlRow | undefined)
        : undefined;
    const replacementFact = replacementRow ? parse(replacementRow) : undefined;
    const result: PendingGovernorRemediation = {
      remediationId: String(row.remediation_id),
      staleRevisionId: String(row.stale_revision_id),
    };
    if (replacementFact) {
      result.replacementFact = replacementFact as MemoryGovernorFact;
    }
    return result;
  });
}

export function markGovernorRemediationCompleted(
  db: DatabaseSync,
  remediationId: string,
  now: number,
): void {
  db.prepare(
    "UPDATE memory_governor_remediations SET state = 'completed', updated_at = ? WHERE remediation_id = ? AND state = 'pending'",
  ).run(now, remediationId);
}
