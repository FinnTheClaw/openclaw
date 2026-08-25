import { createGovernorEventRecord } from "./events.js";
import { applyGovernorTransition } from "./state-machine.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function clearGovernorPendingFinishPhase(
  task: GovernorTaskProjection,
): GovernorTaskProjection {
  if (!task.finalResponsePhase) {
    return task;
  }
  const { finalResponsePhase: _phase, ...withoutPhase } = task;
  return withoutPhase;
}

export function rejectPendingGovernorFinish(params: {
  store: GovernorSqliteStore;
  task: GovernorTaskProjection;
  taskId: GovernorTaskId;
  now: number;
  pendingUserUpdate: string;
  allowExecutingPending?: boolean;
  pendingProgressFingerprint?: string;
}): GovernorTaskProjection {
  if (params.task.state === "REPLAN_REQUIRED" && !params.task.finalResponsePhase) {
    return params.task;
  }
  if (
    params.task.taskId !== params.taskId ||
    (params.task.state !== "VERIFYING" &&
      params.task.state !== "FINISH_CANDIDATE" &&
      !(
        params.task.state === "EXECUTING" &&
        (params.task.finalResponsePhase || params.allowExecutingPending)
      ))
  ) {
    throw new Error("GOVERNOR_PENDING_FINISH_STATE_INVALID");
  }
  const transition = applyGovernorTransition({
    task: params.task,
    expectedTaskVersion: params.task.taskVersion,
    expectedLeaseEpoch: params.task.leaseEpoch,
    to: "REPLAN_REQUIRED",
    now: params.now,
  });
  if (!transition.applied) {
    throw new Error("GOVERNOR_PENDING_FINISH_REJECTED");
  }
  const next = clearGovernorPendingFinishPhase(transition.task);
  const event = createGovernorEventRecord({
    task: next,
    eventType: "finish_rejected",
    payload: {
      unmetCriteria: [],
      semanticFailures: [],
      reconciliationEffectIds: [],
      runningActionIds: [],
      pendingUserUpdate: params.pendingUserUpdate,
      ...(params.pendingProgressFingerprint
        ? { pendingProgressFingerprint: params.pendingProgressFingerprint }
        : {}),
      unsupportedMaterialClaimIds: [],
    },
    now: params.now,
  });
  const result = params.store.commit({ current: params.task, next, event });
  if (!result.applied) {
    throw new Error("GOVERNOR_PENDING_FINISH_COMMIT_REJECTED");
  }
  return result.task;
}
