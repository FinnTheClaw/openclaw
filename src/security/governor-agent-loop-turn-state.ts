import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { buildGovernorAgentLoopProgress } from "./governor-agent-loop-progress.js";
import type { GovernorAgentLoopTurnState } from "./governor-agent-loop-turn-handler.js";

export function createGovernorAgentLoopTurnState(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  config: GovernorAgentLoopConfiguration;
  turns: number;
  terminal: boolean;
}): GovernorAgentLoopTurnState {
  const progress = buildGovernorAgentLoopProgress(params.controller, params.taskId, params.config);
  return {
    turns: params.turns,
    progress,
    priorProgressFingerprint: progress.fingerprint,
    replannedAfterStagnation: false,
    skipNextStagnationCheck: false,
    toolErrorObserved: false,
    finalResponsePending: false,
    terminal: params.terminal,
  };
}
