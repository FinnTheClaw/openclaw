import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";

export function reconstructGovernorAgentLoopTurns(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  executionGeneration: number;
  safetyBudget: number;
  now: number;
}): number {
  const turns = params.controller.store
    .listEvents(params.taskId)
    .filter((event) => {
      const payload = event.payload;
      return (
        event.eventType === "runtime_model_turn_recorded" &&
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.executionGeneration === params.executionGeneration &&
        typeof payload.turn === "number" &&
        Number.isSafeInteger(payload.turn) &&
        payload.turn > 0
      );
    })
    .reduce((maximum, event) => {
      const payload = event.payload as { turn: number };
      return Math.max(maximum, payload.turn);
    }, 0);
  if (turns >= params.safetyBudget) {
    const task = params.controller.store.loadTask(params.taskId);
    if (task?.state === "EXECUTING") {
      params.controller.blockRuntime(params.taskId, params.now + 1, "budget_exhausted");
    }
    throw new Error("GOVERNOR_AGENT_LOOP_BUDGET_EXHAUSTED");
  }
  return turns;
}
