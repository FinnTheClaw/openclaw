import type { GovernorAgentLoopMode } from "./governor-agent-loop-config.js";
import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";

export function createGovernorCompletedReplayScope(
  taskId: string,
  mode: GovernorAgentLoopMode,
): GovernorAgentLoopRunScope {
  return Object.freeze({
    taskId,
    mode,
    disposition: "completed_replay" as const,
    beforeTool() {
      return { kind: "block" as const, reasonCode: "GOVERNOR_COMPLETED_REPLAY" };
    },
    afterTool() {},
    afterTurn() {
      return { kind: "complete" as const };
    },
    interrupt() {},
    assertTerminal() {},
    governedTools() {
      return [];
    },
    dispose() {},
  });
}
