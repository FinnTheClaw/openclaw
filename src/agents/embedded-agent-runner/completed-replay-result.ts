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
}): EmbeddedAgentRunResult {
  return {
    meta: {
      durationMs: Date.now() - input.startedAt,
      agentMeta: {
        sessionId: input.sessionId,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        provider: input.provider ?? "unknown",
        model: input.model ?? "unknown",
        ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
      },
      terminalReplyKind: "silent-empty",
      stopReason: "completed_replay",
      livenessState: "working",
      completion: { stopReason: "completed_replay", finishReason: "completed_replay" },
    },
  };
}
