// Admits only current, same-scope, externally sourced evidence.
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorEvidenceSourceKind =
  | "tool"
  | "structured_external"
  | "authenticated_user"
  | "memory_candidate"
  | "assistant_text"
  | "hidden_reasoning";

export type GovernorEvidenceCandidate = {
  evidenceId: string;
  taskId: GovernorTaskId;
  criterionId: string;
  sourceKind: GovernorEvidenceSourceKind;
  sourceIdentity: string;
  taskVersion: number;
  objectiveRevision: number;
  scopeKey: string;
  observedAt: number;
  payload: GovernorJsonValue;
  evidenceDigest: string;
};

export type GovernorEvidenceRecord = GovernorEvidenceCandidate & {
  admissibility: "admitted";
  createdAt: number;
  invalidatedAt?: number;
};

export type GovernorEvidenceAdmission =
  | { admitted: true; evidence: GovernorEvidenceRecord }
  | {
      admitted: false;
      reason:
        | "assistant_source"
        | "scope_mismatch"
        | "objective_revision_mismatch"
        | "future_task_version"
        | "unknown_criterion"
        | "digest_mismatch";
    };

export function createGovernorEvidenceCandidate(
  params: Omit<GovernorEvidenceCandidate, "evidenceDigest">,
): GovernorEvidenceCandidate {
  const safe = assertGovernorBoundarySafe(
    "model",
    params as unknown as GovernorJsonValue,
  ) as unknown as Omit<GovernorEvidenceCandidate, "evidenceDigest">;
  return {
    ...safe,
    evidenceDigest: governorDigest(safe.payload),
  };
}

export function admitGovernorEvidence(params: {
  task: GovernorTaskProjection;
  candidate: GovernorEvidenceCandidate;
  now: number;
}): GovernorEvidenceAdmission {
  if (
    params.candidate.sourceKind === "assistant_text" ||
    params.candidate.sourceKind === "hidden_reasoning"
  ) {
    return { admitted: false, reason: "assistant_source" };
  }
  if (params.candidate.scopeKey !== params.task.scopeKey) {
    return { admitted: false, reason: "scope_mismatch" };
  }
  if (params.candidate.objectiveRevision !== params.task.objectiveRevision) {
    return { admitted: false, reason: "objective_revision_mismatch" };
  }
  if (params.candidate.taskVersion > params.task.taskVersion) {
    return { admitted: false, reason: "future_task_version" };
  }
  if (
    !params.task.contract.completionCriteria.some(
      (criterion) => criterion.criterionId === params.candidate.criterionId,
    )
  ) {
    return { admitted: false, reason: "unknown_criterion" };
  }
  if (governorDigest(params.candidate.payload) !== params.candidate.evidenceDigest) {
    return { admitted: false, reason: "digest_mismatch" };
  }
  return {
    admitted: true,
    evidence: {
      ...structuredClone(params.candidate),
      admissibility: "admitted",
      createdAt: params.now,
    },
  };
}
