import { createGovernorActionFingerprint } from "./action-fingerprint.js";
// Defines the durable, pre-execution authorization ticket for a governed tool action.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { governorProgressVectorHash } from "./progress-monitor.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import {
  opaqueGovernorReference,
  type GovernorIdentityContext,
  type GovernorTaskId,
  type GovernorTaskProjection,
} from "./types.js";

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

export function toPersistentGovernorActionProposal(
  proposal: GovernorActionProposal,
  identity: GovernorIdentityContext,
): GovernorActionProposal {
  return {
    ...proposal,
    canonicalTarget: /^[a-f0-9]{64}$/u.test(proposal.canonicalTarget)
      ? proposal.canonicalTarget
      : opaqueGovernorReference("action-target", proposal.canonicalTarget, identity),
  };
}

export function createGovernorActionIntent(params: {
  task: GovernorTaskProjection;
  proposal: GovernorActionProposal;
  progressVector: GovernorJsonValue;
  forceReplanAfterOutcome: boolean;
  now: number;
  identity: GovernorIdentityContext;
}): GovernorActionIntent {
  const rawProposal = assertGovernorBoundarySafe(
    "log",
    params.proposal as unknown as GovernorJsonValue,
  ) as unknown as GovernorActionProposal;
  const proposal = toPersistentGovernorActionProposal(rawProposal, params.identity);
  return {
    taskId: params.task.taskId,
    effectId: proposal.effectId,
    idempotencyKey: governorDigest({
      taskId: params.task.taskId,
      effectId: proposal.effectId,
      objectiveRevision: params.task.objectiveRevision,
      planVersion: params.task.planVersion,
      executionGeneration: params.task.executionGeneration,
    }),
    taskVersion: params.task.taskVersion + 1,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    leaseEpoch: params.task.leaseEpoch,
    executionGeneration: params.task.executionGeneration,
    state: "admitted",
    claimEpoch: 0,
    proposal,
    proposalDigest: governorDigest(proposal as unknown as GovernorJsonValue),
    actionFingerprint: createGovernorActionFingerprint(proposal, params.identity),
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
    intent.taskId === proposal.taskId &&
    intent.effectId === proposal.effectId &&
    intent.proposalDigest === governorDigest(proposal as unknown as GovernorJsonValue) &&
    intent.idempotencyKey ===
      governorDigest({
        taskId: proposal.taskId,
        effectId: proposal.effectId,
        objectiveRevision: intent.objectiveRevision,
        planVersion: intent.planVersion,
        executionGeneration: intent.executionGeneration,
      })
  );
}
