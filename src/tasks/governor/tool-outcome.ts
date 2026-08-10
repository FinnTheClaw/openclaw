import { createGovernorActionFingerprint } from "./action-fingerprint.js";
// Separates tool transport, semantic, side-effect, and verification outcomes.
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
import { governorProgressVectorHash } from "./progress-monitor.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorEffectId, GovernorTaskId } from "./types.js";

export type GovernorSemanticOutcome =
  | "success"
  | "not_found"
  | "ambiguous"
  | "partial"
  | "denied"
  | "transient_failure"
  | "permanent_failure"
  | "cancelled";

export type GovernorToolOutcome = {
  transport: "completed" | "failed" | "unknown";
  semantic: GovernorSemanticOutcome;
  sideEffect: "not_applicable" | "none" | "applied" | "unknown";
  verification: "not_required" | "required" | "verified" | "failed";
  summaryCode: string;
  evidence?: GovernorJsonValue;
};

export type GovernorActionProposal = {
  taskId: GovernorTaskId;
  effectId: GovernorEffectId;
  criterionId?: string;
  capability: string;
  capabilityVersion: string;
  canonicalTarget: string;
  expectedEvidence: string;
  sourceRank: "structured_exact" | "scoped_index" | "targeted_search" | "broad_scan";
  stopCondition: string;
  mutating: boolean;
  argumentsDigest: string;
  approvalGrant?: {
    grantId: string;
    objectiveRevision: number;
    capabilityVersion: string;
    canonicalTarget: string;
    revokedAt?: number;
  };
};

export type GovernorEffectRecord = GovernorActionProposal & {
  idempotencyKey: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  actionFingerprint: string;
  progressVectorHash: string;
  outcome: GovernorToolOutcome;
  verificationState: GovernorToolOutcome["verification"];
  reconcileRequired: boolean;
  createdAt: number;
  updatedAt: number;
};

export { createGovernorActionFingerprint } from "./action-fingerprint.js";

export function createGovernorEffectRecord(params: {
  proposal: GovernorActionProposal;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  progressVector: GovernorJsonValue;
  outcome: GovernorToolOutcome;
  now: number;
}): GovernorEffectRecord {
  const safeProposal = assertGovernorBoundarySafe(
    "log",
    params.proposal as unknown as GovernorJsonValue,
  ) as unknown as GovernorActionProposal;
  const safeOutcome = assertGovernorBoundarySafe(
    "model",
    params.outcome as unknown as GovernorJsonValue,
  ) as unknown as GovernorToolOutcome;
  const reconcileRequired =
    safeProposal.mutating &&
    (safeOutcome.transport === "unknown" || safeOutcome.sideEffect === "unknown");
  const verificationState = safeProposal.mutating
    ? safeOutcome.verification === "verified"
      ? "verified"
      : "required"
    : safeOutcome.verification;
  return {
    ...safeProposal,
    idempotencyKey: governorDigest({
      taskId: safeProposal.taskId,
      effectId: safeProposal.effectId,
    }),
    taskVersion: params.taskVersion,
    objectiveRevision: params.objectiveRevision,
    planVersion: params.planVersion,
    leaseEpoch: params.leaseEpoch,
    executionGeneration: params.executionGeneration,
    actionFingerprint: createGovernorActionFingerprint(safeProposal),
    progressVectorHash: governorProgressVectorHash(params.progressVector),
    outcome: safeOutcome,
    verificationState,
    reconcileRequired,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function isGovernorEffectSemanticallySuccessful(effect: GovernorEffectRecord): boolean {
  return (
    effect.outcome.transport === "completed" &&
    effect.outcome.semantic === "success" &&
    !effect.reconcileRequired
  );
}
