import { createGovernorActionFingerprint } from "./action-fingerprint.js";
// Defines the durable, pre-execution authorization ticket for a governed tool action.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { governorProgressVectorHash } from "./progress-monitor.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorActionIntentState = "admitted" | "running" | "completed" | "cancelled";

export type GovernorActionIntent = {
  taskId: GovernorTaskId;
  effectId: string;
  idempotencyKey: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  state: GovernorActionIntentState;
  claimEpoch: number;
  claimedBy?: string;
  leaseExpiresAt?: number;
  proposal: GovernorActionProposal;
  proposalDigest: string;
  actionFingerprint: string;
  progressVectorHash: string;
  forceReplanAfterOutcome: boolean;
  createdAt: number;
  completedAt?: number;
  cancelledAt?: number;
  updatedAt: number;
};

export function createGovernorActionIntent(params: {
  task: GovernorTaskProjection;
  proposal: GovernorActionProposal;
  progressVector: GovernorJsonValue;
  forceReplanAfterOutcome: boolean;
  now: number;
}): GovernorActionIntent {
  const proposal = assertGovernorBoundarySafe(
    "log",
    params.proposal as unknown as GovernorJsonValue,
  ) as unknown as GovernorActionProposal;
  return {
    taskId: params.task.taskId,
    effectId: proposal.effectId,
    idempotencyKey: governorDigest({ taskId: params.task.taskId, effectId: proposal.effectId }),
    taskVersion: params.task.taskVersion + 1,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    leaseEpoch: params.task.leaseEpoch,
    executionGeneration: params.task.executionGeneration,
    state: "admitted",
    claimEpoch: 0,
    proposal,
    proposalDigest: governorDigest(proposal as unknown as GovernorJsonValue),
    actionFingerprint: createGovernorActionFingerprint(proposal),
    progressVectorHash: governorProgressVectorHash(params.progressVector),
    forceReplanAfterOutcome: params.forceReplanAfterOutcome,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function isSameGovernorActionIntent(
  intent: GovernorActionIntent,
  proposal: GovernorActionProposal,
): boolean {
  return (
    intent.proposalDigest === governorDigest(proposal as unknown as GovernorJsonValue) &&
    intent.idempotencyKey ===
      governorDigest({ taskId: proposal.taskId, effectId: proposal.effectId })
  );
}
