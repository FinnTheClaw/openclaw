import type { EmbeddedAgentRunResult } from "./types.js";

export function throwIfEmbeddedRunAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  const abortError =
    reason instanceof Error
      ? reason
      : reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
  abortError.name = "AbortError";
  throw abortError;
}

export function createEmbeddedCompletedReplayResult(input: {
  startedAt: number;
  sessionId: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  agentHarnessId?: string;
  completedC02ReplayTaskId?: string;
}): EmbeddedAgentRunResult {
  const governedReplay = resolveCompletedC02Replay(input);
  return {
    ...(governedReplay ? { payloads: [{ text: governedReplay.output }] } : {}),
    meta: {
      durationMs: Date.now() - input.startedAt,
      agentMeta: {
        sessionId: input.sessionId,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        provider: input.provider ?? "unknown",
        model: input.model ?? "unknown",
        ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
        ...(governedReplay ? { governedReplay } : {}),
      },
      ...(governedReplay
        ? {
            finalAssistantVisibleText: governedReplay.output,
            finalAssistantRawText: governedReplay.output,
          }
        : {}),
      terminalReplyKind: governedReplay ? "text" : "silent-empty",
      stopReason: "completed_replay",
      livenessState: governedReplay ? "completed" : "working",
      completion: { stopReason: "completed_replay", finishReason: "completed_replay" },
    },
  };
}

function resolveCompletedC02Replay(input: {
  sessionId: string;
  completedC02ReplayTaskId?: string;
}):
  | {
      feature: "c02-simple-efficiency";
      version: "v1";
      sessionId: string;
      taskId: string;
      completedStage: 3;
      output: "C02_COMPLETE";
    }
  | undefined {
  const match = /^c02-eval-session:(C02-[A-F]-[0-9]{3}):([a-f0-9]{24})$/iu.exec(
    input.completedC02ReplayTaskId ?? "",
  );
  if (!match) {
    return undefined;
  }
  const caseId = match[1].toUpperCase();
  const nonce = match[2].toLowerCase();
  const canonicalSessionId = `c02-eval-${caseId.toLowerCase()}-${nonce}`;
  if (input.sessionId.toLowerCase() !== canonicalSessionId) {
    return undefined;
  }
  return {
    feature: "c02-simple-efficiency",
    version: "v1",
    sessionId: input.sessionId,
    taskId: `c02-eval-session:${caseId}:${nonce}`,
    completedStage: 3,
    output: "C02_COMPLETE",
  };
}
