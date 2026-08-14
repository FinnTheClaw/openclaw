import { createGovernorEventRecord } from "./events.js";
import { applyGovernorTransition } from "./state-machine.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function rejectPendingGovernorFinish(params: {
  store: GovernorSqliteStore;
  task: GovernorTaskProjection;
  taskId: GovernorTaskId;
  now: number;
  pendingUserUpdate: string;
}): GovernorTaskProjection {
  if (
    params.task.taskId !== params.taskId ||
    (params.task.state !== "VERIFYING" && params.task.state !== "FINISH_CANDIDATE")
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
  const event = createGovernorEventRecord({
    task: transition.task,
    eventType: "finish_rejected",
    payload: {
      unmetCriteria: [],
      semanticFailures: [],
      reconciliationEffectIds: [],
      runningActionIds: [],
      pendingUserUpdate: params.pendingUserUpdate,
      unsupportedMaterialClaimIds: [],
    },
    now: params.now,
  });
  const result = params.store.commit({ current: params.task, next: transition.task, event });
  if (!result.applied) {
    throw new Error("GOVERNOR_PENDING_FINISH_COMMIT_REJECTED");
  }
  return result.task;
}
