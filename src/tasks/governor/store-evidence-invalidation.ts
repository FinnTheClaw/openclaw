import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { createGovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import { bindEvidence, bindEvent, governorDb } from "./store-codec.js";
import { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import { loadGovernorEvidence, loadGovernorTask } from "./store-queries.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorTaskId } from "./types.js";

export type GovernorEvidenceInvalidationReason =
  | "contradicted_by_newer_evidence"
  | "scope_revoked"
  | "freshness_expired"
  | "operator_requested";

const INVALIDATION_REASONS = new Set<GovernorEvidenceInvalidationReason>([
  "contradicted_by_newer_evidence",
  "scope_revoked",
  "freshness_expired",
  "operator_requested",
]);

export function invalidateGovernorEvidence(params: {
  options: OpenClawStateDatabaseOptions;
  admissions: GovernorEvidenceAdmissionStore;
  tasks: GovernorTaskAuthorityStore;
  taskId: GovernorTaskId;
  evidenceId: string;
  reasonCode: GovernorEvidenceInvalidationReason;
  now: number;
}): GovernorEvidenceRecord {
  if (!INVALIDATION_REASONS.has(params.reasonCode)) {
    throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_REASON_INVALID");
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const task = loadGovernorTask(db, params.taskId, params.tasks);
    if (!task) {
      throw new Error("GOVERNOR_TASK_NOT_FOUND");
    }
    const evidence = loadGovernorEvidence(db, params.taskId, params.evidenceId, (record) =>
      params.admissions.verify(record),
    );
    if (!evidence) {
      throw new Error("GOVERNOR_EVIDENCE_NOT_FOUND");
    }
    if (evidence.invalidatedAt !== undefined) {
      return evidence;
    }
    if (
      evidence.scopeKey !== task.scopeKey ||
      evidence.objectiveRevision !== task.objectiveRevision ||
      evidence.planVersion !== task.planVersion ||
      evidence.taskVersion > task.taskVersion
    ) {
      throw new Error("GOVERNOR_EVIDENCE_NOT_CURRENT");
    }
    const invalidated = params.admissions.invalidate(evidence, params.now);
    const update = executeSqliteQuerySync(
      db,
      governorDb(db)
        .updateTable("governor_evidence")
        .set(bindEvidence(invalidated, (record) => params.admissions.verify(record)))
        .where("task_id", "=", params.taskId)
        .where("evidence_id", "=", params.evidenceId)
        .where("admission_signature", "=", evidence.admissionSignature)
        .where("invalidated_at", "is", null),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_CONFLICT");
    }
    const event = createGovernorEventRecord({
      task,
      eventType: "evidence_invalidated",
      payload: {
        evidenceId: evidence.evidenceId,
        evidenceDigest: evidence.evidenceDigest,
        reasonCode: params.reasonCode,
      },
      now: params.now,
    });
    executeSqliteQuerySync(
      db,
      governorDb(db).insertInto("governor_events").values(bindEvent(event)),
    );
    return invalidated;
  }, params.options);
}
