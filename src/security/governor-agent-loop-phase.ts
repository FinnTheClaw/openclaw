import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { rejectStaleGovernorPendingFinish } from "./governor-agent-loop-finish-recovery.js";
import {
  buildGovernorAgentLoopProgress,
  type GovernorAgentLoopProgressSnapshot,
} from "./governor-agent-loop-progress.js";
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
      now: Date.now(),
    })
  ) {
    params.state.finalResponsePending = false;
  }
  return params.state.finalResponsePending ? "final_response" : "actions";
}
