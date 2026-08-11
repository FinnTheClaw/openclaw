// Admits only current, same-scope, externally sourced evidence.
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import {
  opaqueGovernorReference,
  type GovernorTaskId,
  type GovernorTaskProjection,
} from "./types.js";

declare const governorOpaqueEvidenceSourceRefBrand: unique symbol;

/** A keyed, non-reversible reference that is safe to retain with evidence. */
export type OpaqueEvidenceSourceRef = string & {
  readonly [governorOpaqueEvidenceSourceRefBrand]: true;
};

const OPAQUE_EVIDENCE_SOURCE_REF = /^oesr_[a-f0-9]{64}$/u;

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
  planVersion: number;
  scopeKey: string;
  observedAt: number;
  payload: GovernorJsonValue;
  evidenceDigest: string;
  predicate?: string;
  value?: GovernorJsonValue;
};

export type GovernorEvidenceRecord = Omit<
  GovernorEvidenceCandidate,
  "sourceIdentity" | "predicate" | "value"
> & {
  sourceIdentity: OpaqueEvidenceSourceRef;
  predicate: string;
  value: GovernorJsonValue;
  semanticDigest: string;
  admissibility: "admitted";
  createdAt: number;
  invalidatedAt?: number;
};

export function isOpaqueEvidenceSourceRef(value: string): value is OpaqueEvidenceSourceRef {
  return OPAQUE_EVIDENCE_SOURCE_REF.test(value);
}

export function assertOpaqueEvidenceSourceRef(value: string): OpaqueEvidenceSourceRef {
  if (!isOpaqueEvidenceSourceRef(value)) {
    throw new Error("Governor evidence source identity must be an opaque keyed reference");
  }
  return value;
}

function opaqueEvidenceSourceRef(
  sourceKind: GovernorEvidenceSourceKind,
  sourceIdentity: string,
): OpaqueEvidenceSourceRef {
  return `oesr_${opaqueGovernorReference(`evidence-source:${sourceKind}`, sourceIdentity)}` as OpaqueEvidenceSourceRef;
}

function semanticEvidence(params: {
  criterionId: string;
  predicate?: string;
  value?: GovernorJsonValue;
  payload: GovernorJsonValue;
}): { predicate: string; value: GovernorJsonValue; semanticDigest: string } {
  const predicate = (params.predicate ?? `criterion:${params.criterionId}`).trim();
  if (!predicate) {
    throw new Error("Governor evidence predicate must not be empty");
  }
  const value = params.value ?? params.payload;
  return { predicate, value, semanticDigest: governorDigest({ predicate, value }) };
}

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
  if (params.candidate.planVersion !== params.task.planVersion) {
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
      sourceIdentity: opaqueEvidenceSourceRef(
        params.candidate.sourceKind,
        params.candidate.sourceIdentity,
      ),
      ...semanticEvidence(params.candidate),
      admissibility: "admitted",
      createdAt: params.now,
    },
  };
}
