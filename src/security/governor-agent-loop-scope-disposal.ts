import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopMode } from "./governor-agent-loop-config.js";

export function terminalizeShadowGovernorScope(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  mode: GovernorAgentLoopMode;
  now?: number;
}): void {
  if (params.mode !== "shadow") {
    return;
  }
  if (params.controller.store.loadTask(params.taskId)?.state === "EXECUTING") {
    params.controller.blockRuntime(
      params.taskId,
      (params.now ?? Date.now()) + 1,
      "shadow_observed",
    );
  }
}
