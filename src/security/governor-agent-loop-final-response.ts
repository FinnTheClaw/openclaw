import type { GovernorController } from "../tasks/governor/controller.js";
import { createGovernorEventRecord } from "../tasks/governor/events.js";
import type { GovernorTaskId, GovernorTaskProjection } from "../tasks/governor/types.js";

function commitPhase(
  controller: GovernorController,
  current: GovernorTaskProjection,
  next: GovernorTaskProjection,
  pending: boolean,
  now: number,
): GovernorTaskProjection {
  const event = createGovernorEventRecord({
    task: next,
    eventType: "runtime_finish_proposed",
    payload: {
      phase: "final_response",
      finalResponsePending: pending,
      planVersion: next.planVersion,
      progressDigest: next.finalResponsePhase?.progressDigest ?? null,
    },
    now,
  });
  const result = controller.store.commit({ current, next, event });
  if (!result.applied) {
    throw new Error("GOVERNOR_FINAL_RESPONSE_PHASE_CONFLICT");
  }
  return result.task;
}

export function setGovernorFinalResponsePending(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  progressDigest: string;
  now: number;
}): GovernorTaskProjection {
  const current = params.controller.store.loadTask(params.taskId);
  if (!current) {
    throw new Error("GOVERNOR_TASK_NOT_FOUND");
  }
  if (
    current.finalResponsePhase?.progressDigest === params.progressDigest &&
    current.finalResponsePhase.planVersion === current.planVersion &&
    current.finalResponsePhase.objectiveRevision === current.objectiveRevision
  ) {
    return current;
  }
  const next: GovernorTaskProjection = {
    ...current,
    finalResponsePhase: {
      progressDigest: params.progressDigest,
      planVersion: current.planVersion,
      objectiveRevision: current.objectiveRevision,
      requestedAt: params.now,
    },
    taskVersion: current.taskVersion + 1,
    updatedAt: params.now,
  };
  return commitPhase(params.controller, current, next, true, params.now);
}

export function clearGovernorFinalResponsePending(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  now: number;
}): GovernorTaskProjection {
  const current = params.controller.store.loadTask(params.taskId);
  if (!current) {
    throw new Error("GOVERNOR_TASK_NOT_FOUND");
  }
  if (!current.finalResponsePhase) {
    return current;
  }
  const { finalResponsePhase: _phase, ...withoutPhase } = current;
  const next = { ...withoutPhase, taskVersion: current.taskVersion + 1, updatedAt: params.now };
  return commitPhase(params.controller, current, next, false, params.now);
}
