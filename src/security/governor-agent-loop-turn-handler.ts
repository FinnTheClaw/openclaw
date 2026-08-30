import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import {
  buildGovernorAgentLoopProgress,
  formatGovernorAgentLoopProgress,
  type GovernorAgentLoopProgressSnapshot,
} from "./governor-agent-loop-progress.js";
import type { GovernorAgentLoopTurnDecision } from "./governor-agent-loop-types.js";
import { isExactGovernorC02Module } from "./governor-c02-module-identity.js";

export type GovernorAgentLoopTurnState = {
  turns: number;
  progress: GovernorAgentLoopProgressSnapshot;
  priorProgressFingerprint: string;
  replannedAfterStagnation: boolean;
  skipNextStagnationCheck: boolean;
  toolErrorObserved: boolean;
  toolErrorEffectId?: string;
  lastObservedEffectId?: string;
  lastObservedToolName?: string;
  lastObservedResultDigest?: string;
  terminal: boolean;
  terminalReason?: string;
};

export function recordGovernorAgentLoopTurn(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  config: GovernorAgentLoopConfiguration;
  currentExecutionGeneration: number;
  safetyBudget: number;
  state: GovernorAgentLoopTurnState;
  turn: {
    assistantText: string;
    assistantStopReason?: string;
    toolCallCount: number;
    finnRequestIds?: readonly string[];
    finnRequestIdEvidenceComplete?: boolean;
    now: number;
  };
}): GovernorAgentLoopTurnDecision {
  const { state, turn } = params;
  state.turns += 1;
  state.progress = buildGovernorAgentLoopProgress(params.controller, params.taskId, params.config);
  const progressed = state.progress.fingerprint !== state.priorProgressFingerprint;
  const skipStagnationCheck = state.skipNextStagnationCheck;
  state.skipNextStagnationCheck = false;
  const observedToolError = state.toolErrorObserved;
  state.toolErrorObserved = false;
  const observedToolErrorEffectId = state.toolErrorEffectId;
  state.toolErrorEffectId = undefined;
  if (progressed) {
    state.replannedAfterStagnation = false;
  }
  let stopAfterTurnReason: string | undefined;
  if (observedToolError && params.config.mode === "enforce") {
    if (state.replannedAfterStagnation) {
      stopAfterTurnReason = "GOVERNOR_AGENT_LOOP_NO_PROGRESS";
    } else {
      params.controller.recordRuntimeReplanGuidance(params.taskId, turn.now + 1, {
        reasonCode: "tool_semantic_failure",
        progressDigest: state.progress.fingerprint,
        ...(observedToolErrorEffectId ? { sourceEffectId: observedToolErrorEffectId } : {}),
      });
      state.replannedAfterStagnation = true;
    }
  }
  state.priorProgressFingerprint = state.progress.fingerprint;
  const recordsC02Source = isExactGovernorC02Module(params.config);
  params.controller.recordRuntimeEvent({
    taskId: params.taskId,
    eventType: "runtime_model_turn_recorded",
    payload: {
      turn: state.turns,
      assistantTextDigest: governorDigest(turn.assistantText),
      toolCallCount: turn.toolCallCount,
      stopReason: turn.assistantStopReason ?? "unknown",
      planVersion: state.progress.planVersion,
      executionGeneration: params.currentExecutionGeneration,
      satisfiedCriteria: state.progress.satisfiedCriteria.length,
      remainingCriteria: state.progress.remainingCriteria.length,
      progressDigest: state.progress.fingerprint,
      ...(recordsC02Source
        ? {
            sourceEffectId: state.lastObservedEffectId ?? null,
            sourceToolName: state.lastObservedToolName ?? null,
            sourceResultDigest: state.lastObservedResultDigest ?? null,
            finnRequestIds: [...(turn.finnRequestIds ?? [])],
            finnRequestIdEvidenceComplete: turn.finnRequestIdEvidenceComplete === true,
          }
        : {}),
    },
    now: turn.now,
  });
  state.lastObservedEffectId = undefined;
  state.lastObservedToolName = undefined;
  state.lastObservedResultDigest = undefined;
  if (params.config.mode === "shadow") {
    if (turn.toolCallCount === 0) {
      params.controller.recordRuntimeEvent({
        taskId: params.taskId,
        eventType: "runtime_finish_proposed",
        payload: { mode: "shadow", turn: state.turns },
        now: turn.now + 1,
      });
    }
    return { kind: "complete" };
  }
  if (turn.assistantStopReason === "error" || turn.assistantStopReason === "aborted") {
    return { kind: "interrupt", reasonCode: "GOVERNOR_AGENT_LOOP_PROVIDER_INTERRUPTED" };
  }
  if (stopAfterTurnReason) {
    state.terminalReason = stopAfterTurnReason;
    params.controller.blockRuntime(params.taskId, turn.now + 1, "tool_semantic_failure");
    return { kind: "stop", reasonCode: state.terminalReason };
  }
  if (turn.toolCallCount > 0 && state.turns >= params.safetyBudget) {
    state.terminalReason = "GOVERNOR_AGENT_LOOP_BUDGET_EXHAUSTED";
    params.controller.blockRuntime(params.taskId, turn.now + 1, "budget_exhausted");
    return { kind: "stop", reasonCode: state.terminalReason };
  }
  if (turn.toolCallCount > 0 && !progressed && !skipStagnationCheck) {
    if (state.replannedAfterStagnation) {
      state.terminalReason = "GOVERNOR_AGENT_LOOP_NO_PROGRESS";
      params.controller.blockRuntime(params.taskId, turn.now + 1, "semantic_stagnation");
      return { kind: "stop", reasonCode: state.terminalReason };
    }
    params.controller.recordRuntimeReplanGuidance(params.taskId, turn.now + 1, {
      reasonCode: "semantic_stagnation",
      progressDigest: state.progress.fingerprint,
    });
    state.progress = buildGovernorAgentLoopProgress(
      params.controller,
      params.taskId,
      params.config,
    );
    state.priorProgressFingerprint = state.progress.fingerprint;
    state.replannedAfterStagnation = true;
    return {
      kind: "continue",
      message: `${formatGovernorAgentLoopProgress(state.progress)} Progress stalled; the host issued one replan. Choose a different eligible action.`,
    };
  }
  if (turn.toolCallCount > 0) {
    return { kind: "continue", message: formatGovernorAgentLoopProgress(state.progress) };
  }
  const responseDigestMatches =
    !params.config.expectedAssistantTextDigest ||
    governorDigest(turn.assistantText.trim()) === params.config.expectedAssistantTextDigest;
  const decision = params.controller.assessFinish({
    taskId: params.taskId,
    response: { framing: "none", materialClaimIds: [] },
    now: turn.now + 1,
  });
  params.controller.recordRuntimeEvent({
    taskId: params.taskId,
    eventType: "runtime_finish_proposed",
    payload: {
      acceptedByEvidence: decision.accepted,
      responseDigestMatches,
      turn: state.turns,
    },
    now: turn.now + 2,
  });
  if (decision.accepted && responseDigestMatches) {
    params.controller.beginVerification(params.taskId, turn.now + 3);
    const finished = params.controller.proposeFinish({
      taskId: params.taskId,
      response: { framing: "none", materialClaimIds: [] },
      now: turn.now + 4,
    });
    state.terminal = finished.completed;
    if (state.terminal) {
      return { kind: "complete" };
    }
  }
  if (state.turns >= params.safetyBudget) {
    state.terminalReason = "GOVERNOR_AGENT_LOOP_BUDGET_EXHAUSTED";
    params.controller.blockRuntime(params.taskId, turn.now + 1, "budget_exhausted");
    return { kind: "stop", reasonCode: state.terminalReason };
  }
  if (state.replannedAfterStagnation) {
    state.terminalReason = "GOVERNOR_AGENT_LOOP_NO_PROGRESS";
    params.controller.blockRuntime(params.taskId, turn.now + 1, "semantic_stagnation");
    return { kind: "stop", reasonCode: state.terminalReason };
  }
  params.controller.recordRuntimeReplanGuidance(params.taskId, turn.now + 1, {
    reasonCode: "semantic_stagnation",
    progressDigest: state.progress.fingerprint,
  });
  state.replannedAfterStagnation = true;
  return {
    kind: "continue",
    message: `${formatGovernorAgentLoopProgress(state.progress)} Governor completion requires current admitted evidence and verification. The host issued one replan; choose an eligible action.`,
  };
}
