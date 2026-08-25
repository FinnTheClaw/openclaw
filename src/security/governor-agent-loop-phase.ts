import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { rejectStaleGovernorPendingFinish } from "./governor-agent-loop-finish-recovery.js";
import {
  buildGovernorAgentLoopProgress,
  type GovernorAgentLoopProgressSnapshot,
} from "./governor-agent-loop-progress.js";
import { ensureGovernorAgentLoopExecuting } from "./governor-agent-loop-task.js";
import type { GovernorAgentLoopTurnState } from "./governor-agent-loop-turn-handler.js";

export function resolveGovernorAgentLoopTurnPhase(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  config: GovernorAgentLoopConfiguration;
  state: GovernorAgentLoopTurnState;
}): "actions" | "final_response" {
  const progress: GovernorAgentLoopProgressSnapshot = buildGovernorAgentLoopProgress(
    params.controller,
    params.taskId,
    params.config,
  );
  params.state.progress = progress;
  if (
    params.state.finalResponsePending &&
    rejectStaleGovernorPendingFinish({
      controller: params.controller,
      taskId: params.taskId,
      progressFingerprint: progress.fingerprint,
      pendingProgressFingerprint: params.state.finalResponseProgressFingerprint,
      now: Date.now(),
    })
  ) {
    params.state.finalResponsePending = false;
    params.state.finalResponseProgressFingerprint = undefined;
  }
  if (!params.state.finalResponsePending) {
    const currentTask = params.controller.store.loadTask(params.taskId);
    if (currentTask?.state === "REPLAN_REQUIRED") {
      ensureGovernorAgentLoopExecuting(params.controller, params.taskId, Date.now());
      params.state.progress = buildGovernorAgentLoopProgress(
        params.controller,
        params.taskId,
        params.config,
      );
      params.state.priorProgressFingerprint = params.state.progress.fingerprint;
    }
  }
  return params.state.finalResponsePending ? "final_response" : "actions";
}
