// Resolves signed evidence only when it still belongs to the live task objective and plan.
import type { DatabaseSync } from "node:sqlite";
import type { GovernorEvidenceRecord } from "./evidence.js";
import type { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import {
  loadGovernorEvidence,
  loadGovernorTask,
  type GovernorStoreQueries,
} from "./store-queries.js";
import type { GovernorTaskId } from "./types.js";

export function loadCurrentGovernorEvidence(params: {
  admissions: GovernorEvidenceAdmissionStore;
  queries: GovernorStoreQueries;
  taskId: GovernorTaskId;
  evidenceId: string;
}): GovernorEvidenceRecord {
  const evidence = params.queries.loadEvidence(params.taskId, params.evidenceId);
  if (!evidence) {
    throw new Error(`Governor evidence not found: ${params.evidenceId}`);
  }
  const task = params.queries.loadTask(params.taskId);
  if (
    !task ||
    evidence.invalidatedAt !== undefined ||
    evidence.scopeKey !== task.scopeKey ||
    evidence.objectiveRevision !== task.objectiveRevision ||
    evidence.planVersion !== task.planVersion ||
    evidence.taskVersion > task.taskVersion
  ) {
    throw new Error("Governor evidence is stale, invalidated, or out of scope");
  }
  params.admissions.verify(evidence);
  return evidence;
}

export function loadCurrentGovernorEvidenceInTransaction(params: {
  db: DatabaseSync;
  admissions: GovernorEvidenceAdmissionStore;
  taskId: GovernorTaskId;
  evidenceId: string;
}): GovernorEvidenceRecord {
  const evidence = loadGovernorEvidence(params.db, params.taskId, params.evidenceId, (record) =>
    params.admissions.verify(record),
  );
  if (!evidence) {
    throw new Error(`Governor evidence not found: ${params.evidenceId}`);
  }
  const task = loadGovernorTask(params.db, params.taskId);
  if (
    !task ||
    evidence.invalidatedAt !== undefined ||
    evidence.scopeKey !== task.scopeKey ||
    evidence.objectiveRevision !== task.objectiveRevision ||
    evidence.planVersion !== task.planVersion ||
    evidence.taskVersion > task.taskVersion
  ) {
    throw new Error("Governor evidence is stale, invalidated, or out of scope");
  }
  params.admissions.verify(evidence);
  return evidence;
}
