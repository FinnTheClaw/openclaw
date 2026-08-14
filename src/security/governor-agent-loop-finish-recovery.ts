import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";

export function rejectStaleGovernorPendingFinish(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  progressFingerprint: string;
  now: number;
}): boolean {
  const task = params.controller.store.loadTask(params.taskId);
  if (
    !task?.finalResponsePhase ||
    task.finalResponsePhase.progressDigest === params.progressFingerprint
  ) {
    return false;
  }
  params.controller.rejectPendingFinish({
    taskId: params.taskId,
    now: params.now,
    pendingUserUpdate: "Current evidence changed while final response was pending.",
  });
  return true;
}
