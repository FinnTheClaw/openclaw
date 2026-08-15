import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";

export function rejectStaleGovernorPendingFinish(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  progressFingerprint: string;
  pendingProgressFingerprint?: string;
  now: number;
}): boolean {
  const task = params.controller.store.loadTask(params.taskId);
  const pendingProgressFingerprint =
    params.pendingProgressFingerprint ?? task?.finalResponsePhase?.progressDigest;
  if (
    !task ||
    !pendingProgressFingerprint ||
    pendingProgressFingerprint === params.progressFingerprint
  ) {
    return false;
  }
  params.controller.rejectPendingFinish({
    taskId: params.taskId,
    now: params.now,
    pendingUserUpdate: "Current evidence changed while final response was pending.",
    allowExecutingPending: !task.finalResponsePhase,
    pendingProgressFingerprint,
  });
  return true;
}
