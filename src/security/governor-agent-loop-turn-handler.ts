import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import {
  clearGovernorFinalResponsePending,
  setGovernorFinalResponsePending,
} from "./governor-agent-loop-final-response.js";
import {
  buildGovernorAgentLoopProgress,
  formatGovernorAgentLoopProgress,
  type GovernorAgentLoopProgressSnapshot,
} from "./governor-agent-loop-progress.js";
import { advanceGovernorAgentLoopTransientFailure } from "./governor-agent-loop-transient-failure.js";
import type { GovernorAgentLoopTurnDecision } from "./governor-agent-loop-types.js";

export type GovernorAgentLoopTurnState = {
  turns: number;
  progress: GovernorAgentLoopProgressSnapshot;
  priorProgressFingerprint: string;
  replannedAfterStagnation: boolean;
  skipNextStagnationCheck: boolean;
  toolErrorObserved: boolean;
  toolErrorEffectId?: string;
  finalResponsePending: boolean;
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
  let toolErrorRetryApplied = false;
  let toolErrorRetryFailed = false;
  if (observedToolError && params.config.mode === "enforce") {
    const retry = observedToolErrorEffectId
      ? advanceGovernorAgentLoopTransientFailure({
          controller: params.controller,
          taskId: params.taskId,
          sourceEffectId: observedToolErrorEffectId,
          now: turn.now + 1,
        })
      : { kind: "not_eligible" as const };
    if (retry.kind === "retry_exhausted" || retry.kind === "not_eligible") {
      state.terminalReason = "GOVERNOR_AGENT_LOOP_TOOL_REPLAN_FAILED";
      toolErrorRetryFailed = true;
    }
    state.progress = buildGovernorAgentLoopProgress(
      params.controller,
      params.taskId,
      params.config,
    );
    state.priorProgressFingerprint = state.progress.fingerprint;
    state.replannedAfterStagnation = false;
    state.finalResponsePending = false;
    if (retry.kind === "already_replanned") {
      stopAfterTurnReason = "GOVERNOR_AGENT_LOOP_NO_PROGRESS";
    } else if (turn.toolCallCount > 0) {
      toolErrorRetryApplied = true;
    }
  }
  state.priorProgressFingerprint = state.progress.fingerprint;
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
    },
    now: turn.now,
  });
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
  if (toolErrorRetryFailed) {
    params.controller.blockRuntime(params.taskId, turn.now + 1, "tool_semantic_failure");
    return { kind: "stop", reasonCode: state.terminalReason! };
  }
  if (turn.assistantStopReason === "error" || turn.assistantStopReason === "aborted") {
    return { kind: "interrupt", reasonCode: "GOVERNOR_AGENT_LOOP_PROVIDER_INTERRUPTED" };
  }
  if (stopAfterTurnReason) {
    state.terminalReason = stopAfterTurnReason;
    params.controller.blockRuntime(params.taskId, turn.now + 1, "tool_semantic_failure");
    return { kind: "stop", reasonCode: state.terminalReason };
  }
  if (toolErrorRetryApplied) {
    return {
      kind: "continue",
      phase: "actions",
      message: formatGovernorAgentLoopProgress(state.progress),
    };
  }
  const finalResponseTurn = state.finalResponsePending && turn.toolCallCount === 0;
  if (state.finalResponsePending && turn.toolCallCount > 0) {
    state.terminalReason = "GOVERNOR_AGENT_LOOP_FINAL_RESPONSE_ONLY";
    params.controller.blockRuntime(params.taskId, turn.now + 1, "completion_only_violation");
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
      phase: "actions",
      message: `${formatGovernorAgentLoopProgress(state.progress)} Progress stalled; the host issued one replan. Choose a different eligible action.`,
    };
  }
  if (turn.toolCallCount > 0) {
    if (state.progress.remainingCriteria.length === 0) {
      const ready = params.controller.assessFinish({
        taskId: params.taskId,
        response: { framing: "none", materialClaimIds: [] },
        now: turn.now + 1,
      }).accepted;
      if (ready) {
        state.finalResponsePending = true;
        setGovernorFinalResponsePending({
          controller: params.controller,
          taskId: params.taskId,
          progressDigest: state.progress.fingerprint,
          now: turn.now + 2,
        });
        return {
          kind: "continue",
          phase: "final_response",
          message: "Host verified all mandatory evidence. Return the final answer without tools.",
        };
      }
    }
    return {
      kind: "continue",
      phase: "actions",
      message: formatGovernorAgentLoopProgress(state.progress),
    };
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
      ...(finalResponseTurn ? { phase: "final_response" } : {}),
    },
    now: turn.now + 2,
  });
  const currentTask = params.controller.store.loadTask(params.taskId);
  const pendingFinish =
    currentTask?.state === "VERIFYING" || currentTask?.state === "FINISH_CANDIDATE";
  if (pendingFinish) {
    const finishRequest = {
      taskId: params.taskId,
      response: { framing: "none" as const, materialClaimIds: [] },
      now: turn.now + 4,
    };
    const finished = responseDigestMatches
      ? params.controller.resumePendingFinish(finishRequest)
      : {
          completed: false,
          task: params.controller.rejectPendingFinish({
            taskId: params.taskId,
            now: turn.now + 4,
            pendingUserUpdate: "Final response did not match the host-bound response contract.",
          }),
        };
    state.terminal = finished.completed;
    if (state.terminal) {
      return { kind: "complete" };
    }
    clearGovernorFinalResponsePending({
      controller: params.controller,
      taskId: params.taskId,
      now: turn.now + 5,
    });
    state.finalResponsePending = false;
    state.progress = buildGovernorAgentLoopProgress(
      params.controller,
      params.taskId,
      params.config,
    );
    state.priorProgressFingerprint = state.progress.fingerprint;
    state.replannedAfterStagnation = false;
    return {
      kind: "continue",
      phase: "actions",
      message: `${formatGovernorAgentLoopProgress(state.progress)} ${
        finished.task.state === "REPLAN_REQUIRED"
          ? "Current evidence or response validation rejected the pending finish; choose an eligible action."
          : "Governor completion requires current admitted evidence and verification."
      }`,
    };
  }
  if (decision.accepted && responseDigestMatches) {
    const finishRequest = {
      taskId: params.taskId,
      response: { framing: "none" as const, materialClaimIds: [] },
      now: turn.now + 4,
    };
    params.controller.beginVerification(params.taskId, turn.now + 3);
    const finished = params.controller.proposeFinish(finishRequest);
    state.terminal = finished.completed;
    if (state.terminal) {
      return { kind: "complete" };
    }
  }
  if (finalResponseTurn) {
    clearGovernorFinalResponsePending({
      controller: params.controller,
      taskId: params.taskId,
      now: turn.now + 5,
    });
    state.finalResponsePending = false;
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
    phase: "actions",
    message: `${formatGovernorAgentLoopProgress(state.progress)} Governor completion requires current admitted evidence and verification. The host issued one replan; choose an eligible action.`,
  };
}
