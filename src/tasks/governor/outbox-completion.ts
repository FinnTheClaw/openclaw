import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorJsonResources } from "./resource-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskProjection } from "./types.js";

export function createGovernorOutboxCompletion(params: {
  task: GovernorTaskProjection;
  effectId: string;
  payload: GovernorJsonValue;
  now: number;
}) {
  assertGovernorJsonResources(params);
  const payload = assertGovernorBoundarySafe("session", params.payload);
  return {
    taskId: params.task.taskId,
    effectId: params.effectId,
    deliveryKey: governorDigest({ taskId: params.task.taskId, effectId: params.effectId }),
    taskVersion: params.task.taskVersion,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    leaseEpoch: params.task.leaseEpoch,
    executionGeneration: params.task.executionGeneration,
    deliveryClaimEpoch: 0,
    state: "pending" as const,
    payload,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
