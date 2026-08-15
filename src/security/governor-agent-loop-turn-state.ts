import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { buildGovernorAgentLoopProgress } from "./governor-agent-loop-progress.js";
import type { GovernorAgentLoopTurnState } from "./governor-agent-loop-turn-handler.js";

function recordPayload(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function reconstructFinalResponsePending(
  controller: GovernorController,
  taskId: GovernorTaskId,
): { pending: boolean; progressFingerprint?: string } {
  const task = controller.store.loadTask(taskId);
  if (!task || task.state === "COMPLETED" || task.state === "BLOCKED") {
    return { pending: false };
  }
  const recoverableState =
    task.state === "EXECUTING" || task.state === "VERIFYING" || task.state === "FINISH_CANDIDATE";
  if (task.finalResponsePhase) {
    const pending =
      recoverableState &&
      task.finalResponsePhase.objectiveRevision === task.objectiveRevision &&
      task.finalResponsePhase.planVersion === task.planVersion;
    return {
      pending,
      ...(pending ? { progressFingerprint: task.finalResponsePhase.progressDigest } : {}),
    };
  }
  if (!recoverableState) {
    return { pending: false };
  }
  let pending:
    | {
        taskVersion: number;
        objectiveRevision: number;
        planVersion?: number;
        progressDigest?: string;
      }
    | undefined;
  for (const event of controller.store.listEvents(taskId)) {
    if (event.eventType !== "runtime_finish_proposed") {
      continue;
    }
    const payload = recordPayload(event.payload);
    if (payload?.phase !== "final_response") {
      continue;
    }
    if (payload.finalResponsePending === false) {
      pending = undefined;
      continue;
    }
    if (payload.finalResponsePending !== true) {
      continue;
    }
    pending = {
      taskVersion: event.taskVersion,
      objectiveRevision: event.objectiveRevision,
      ...(typeof payload.planVersion === "number" ? { planVersion: payload.planVersion } : {}),
      ...(typeof payload.progressDigest === "string"
        ? { progressDigest: payload.progressDigest }
        : {}),
    };
  }
  if (!pending || pending.objectiveRevision !== task.objectiveRevision) {
    return { pending: false };
  }
  if (pending.planVersion !== undefined && pending.planVersion !== task.planVersion) {
    return { pending: false };
  }
  const isPending =
    pending.taskVersion <= task.taskVersion &&
    (task.state === "EXECUTING" || task.taskVersion - pending.taskVersion <= 2);
  return {
    pending: isPending,
    ...(isPending && pending.progressDigest ? { progressFingerprint: pending.progressDigest } : {}),
  };
}

export function createGovernorAgentLoopTurnState(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  config: GovernorAgentLoopConfiguration;
  turns: number;
  terminal: boolean;
}): GovernorAgentLoopTurnState {
  const progress = buildGovernorAgentLoopProgress(params.controller, params.taskId, params.config);
  const finalResponse = reconstructFinalResponsePending(params.controller, params.taskId);
  return {
    turns: params.turns,
    progress,
    priorProgressFingerprint: progress.fingerprint,
    replannedAfterStagnation: false,
    skipNextStagnationCheck: false,
    toolErrorObserved: false,
    finalResponsePending: finalResponse.pending,
    ...(finalResponse.progressFingerprint
      ? { finalResponseProgressFingerprint: finalResponse.progressFingerprint }
      : {}),
    terminal: params.terminal,
  };
}
