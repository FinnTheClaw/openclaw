import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { recoverGovernorAgentLoopGuidance } from "./governor-agent-loop-guidance-recovery.js";
import { createGovernorAgentLoopTools } from "./governor-agent-loop-tool-bindings.js";
import type { GovernorAgentLoopTurnState } from "./governor-agent-loop-turn-handler.js";
import { governorAgentLoopTopLevelString } from "./governor-agent-loop-values.js";
import { safeGovernorAgentLoopValue } from "./governor-agent-loop-values.js";
import { isExactGovernorC02Module } from "./governor-c02-module-identity.js";

export function createGovernorAgentLoopInstalledInventory(params: {
  config: GovernorAgentLoopConfiguration;
  controller: GovernorController;
  taskId: GovernorTaskId;
  executionGeneration: number;
  turns: number;
  turnState: GovernorAgentLoopTurnState;
  progressDigest: string;
  now: number;
}) {
  if (
    recoverGovernorAgentLoopGuidance({
      controller: params.controller,
      taskId: params.taskId,
      progressDigest: params.progressDigest,
      now: params.now,
    })
  ) {
    params.turnState.replannedAfterStagnation = true;
  }
  const installed = isExactGovernorC02Module(params.config);
  if (installed) {
    const effects = params.controller.store
      .listEffects(params.taskId)
      .filter((effect) => effect.executionGeneration === params.executionGeneration);
    if (effects.length === params.turns + 1) {
      const effect = effects.at(-1)!;
      const binding = params.config.toolBindings.find(
        (item) =>
          item.capability === effect.capability &&
          (item.criterionId === effect.criterionId ||
            Object.values(item.criteriaByValue ?? {}).includes(effect.criterionId ?? "")),
      );
      const resultDigest = effect.outcome.evidence
        ? governorAgentLoopTopLevelString(effect.outcome.evidence, "resultDigest")
        : undefined;
      if (binding && resultDigest) {
        params.turnState.lastObservedEffectId = effect.effectId;
        params.turnState.lastObservedToolName = binding.toolName;
        params.turnState.lastObservedResultDigest = resultDigest;
      }
    }
  }
  let tools: readonly AgentTool[] = installed
    ? Object.freeze([])
    : createGovernorAgentLoopTools(params.config);
  let byName = new Map(tools.map((tool) => [tool.name, tool]));
  let prepared = false;
  return Object.freeze({
    installed,
    prepare(input: readonly AgentTool[]): void {
      if (!installed) {
        return;
      }
      if (prepared || new Set(input).size !== input.length) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_INVENTORY_INVALID");
      }
      tools = Object.freeze(
        params.config.toolBindings.map((binding) => {
          const matches = input.filter((tool) => tool.name === binding.toolName);
          if (matches.length !== 1) {
            throw new Error("GOVERNOR_INSTALLED_TOOL_INVENTORY_INVALID");
          }
          return matches[0]!;
        }),
      );
      byName = new Map(tools.map((tool) => [tool.name, tool]));
      prepared = true;
    },
    tools: () => tools,
    find: (name: string) => byName.get(name),
    record(effectId: string, toolName: string, result: unknown) {
      recordGovernorAgentLoopObservedTurnSource(params.turnState, effectId, toolName, result);
    },
  });
}

function recordGovernorAgentLoopObservedTurnSource(
  state: GovernorAgentLoopTurnState,
  effectId: string,
  toolName: string,
  result: unknown,
): void {
  state.lastObservedEffectId = effectId;
  state.lastObservedToolName = toolName;
  state.lastObservedResultDigest = governorDigest(safeGovernorAgentLoopValue(result));
}
