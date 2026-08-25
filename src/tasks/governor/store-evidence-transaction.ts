import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import { governorDb, parseEvidenceRow } from "./store-codec.js";

/** Revalidates every immutable ancestor while the caller's write transaction is held. */
export function assertCurrentGovernorEvidenceLineageInTransaction(params: {
  db: OpenClawStateDatabase["db"];
  evidence: GovernorEvidenceRecord;
  verify: (evidence: GovernorEvidenceRecord) => void;
}): void {
  const dbx = governorDb(params.db);
  const visited = new Set<string>();
  let child = params.evidence;
  while (child.sourceEvidenceId) {
    const sourceEvidenceId = child.sourceEvidenceId;
    if (visited.has(sourceEvidenceId)) {
      throw new Error("GOVERNOR_EVIDENCE_LINEAGE_CYCLE");
    }
    visited.add(sourceEvidenceId);
    const row = executeSqliteQueryTakeFirstSync(
      params.db,
      dbx
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", params.evidence.taskId)
        .where("evidence_id", "=", sourceEvidenceId),
    );
    if (!row) {
      throw new Error("GOVERNOR_EVIDENCE_LINEAGE_SOURCE_MISMATCH");
    }
    const source = parseEvidenceRow(row, params.verify);
    if (
      source.invalidatedAt !== undefined ||
      source.taskId !== params.evidence.taskId ||
      source.scopeKey !== params.evidence.scopeKey
    ) {
      throw new Error("GOVERNOR_EVIDENCE_SOURCE_INVALIDATED");
    }
    child = source;
  }
}
