import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskProjection } from "./types.js";

export function createGovernorOutboxCompletion(params: {
  task: GovernorTaskProjection;
  effectId: string;
  payload: GovernorJsonValue;
  now: number;
}) {
  assertGovernorPersistedJson("log", params);
  const payload = assertGovernorBoundarySafe("session", params.payload);
  const base = {
    taskId: params.task.taskId,
    effectId: params.effectId,
    taskVersion: params.task.taskVersion,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    leaseEpoch: params.task.leaseEpoch,
    executionGeneration: params.task.executionGeneration,
    deliveryClaimEpoch: 0,
    state: "pending" as const,
    payload,
    payloadDigest: governorDigest(payload),
    createdAt: params.now,
    updatedAt: params.now,
  };
  return {
    ...base,
    deliveryKey: governorDigest({
      taskId: base.taskId,
      effectId: base.effectId,
      objectiveRevision: base.objectiveRevision,
      planVersion: base.planVersion,
      executionGeneration: base.executionGeneration,
      payloadDigest: base.payloadDigest,
    }),
  };
}
