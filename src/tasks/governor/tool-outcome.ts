// Separates tool transport, semantic, side-effect, and verification outcomes.
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
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
  canonicalTarget: string;
  expectedEvidence: string;
  sourceRank: "structured_exact" | "scoped_index" | "targeted_search" | "broad_scan";
  stopCondition: string;
  mutating: boolean;
  argumentsDigest: string;
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

export function createGovernorActionFingerprint(proposal: GovernorActionProposal): string {
  return governorDigest({
    capability: proposal.capability,
    canonicalTarget: proposal.canonicalTarget,
    criterionId: proposal.criterionId ?? null,
    argumentsDigest: proposal.argumentsDigest,
    mutating: proposal.mutating,
  });
}

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
  const reconcileRequired =
    params.proposal.mutating &&
    (params.outcome.transport === "unknown" || params.outcome.sideEffect === "unknown");
  const verificationState = params.proposal.mutating
    ? params.outcome.verification === "verified"
      ? "verified"
      : "required"
    : params.outcome.verification;
  return {
    ...params.proposal,
    idempotencyKey: governorDigest({
      taskId: params.proposal.taskId,
      effectId: params.proposal.effectId,
    }),
    taskVersion: params.taskVersion,
    objectiveRevision: params.objectiveRevision,
    planVersion: params.planVersion,
    leaseEpoch: params.leaseEpoch,
    executionGeneration: params.executionGeneration,
    actionFingerprint: createGovernorActionFingerprint(params.proposal),
    progressVectorHash: governorDigest(params.progressVector),
    outcome: structuredClone(params.outcome),
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
