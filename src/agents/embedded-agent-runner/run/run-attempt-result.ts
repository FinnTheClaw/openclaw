import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { hasOutboundDeliveryEvidence } from "../delivery-evidence.js";
import type { ToolSummaryTrace } from "../types.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function normalizeEmbeddedRunAttemptResult(
  attempt: EmbeddedRunAttemptResult,
): EmbeddedRunAttemptResult {
  const runtimeContinuationReplayMetadata =
    attempt.runtimeContinuationStarted === true
      ? { hadPotentialSideEffects: true, replaySafe: false }
      : undefined;
  return copyCoreTtsAttemptResultProvenance(attempt, {
    ...attempt,
    assistantTexts: attempt.assistantTexts ?? [],
    toolMetas: attempt.toolMetas ?? [],
    acceptedSessionSpawns: attempt.acceptedSessionSpawns ?? [],
    messagesSnapshot: attempt.messagesSnapshot ?? [],
    messagingToolSentTexts: attempt.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: attempt.messagingToolSentTargets ?? [],
    messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads ?? [],
    didDeliverSourceReplyViaMessageTool: attempt.didDeliverSourceReplyViaMessageTool === true,
    itemLifecycle: attempt.itemLifecycle ?? {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    replayMetadata: runtimeContinuationReplayMetadata ??
      attempt.replayMetadata ?? { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata:
      runtimeContinuationReplayMetadata ?? attempt.currentAttemptReplayMetadata ?? undefined,
  });
}

export function hasCompletedModelProgressForIdleBreaker(
  attempt: EmbeddedRunAttemptResult,
): boolean {
  return (
    attempt.assistantTexts.some((text) => text.trim().length > 0) ||
    attempt.toolMetas.length > 0 ||
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    hasOutboundDeliveryEvidence(attempt) ||
    attempt.itemLifecycle.completedCount > 0
  );
}

export function buildTraceToolSummary(params: {
  toolMetas?: EmbeddedRunAttemptResult["toolMetas"];
  lastToolError?: EmbeddedRunAttemptResult["lastToolError"];
}): ToolSummaryTrace | undefined {
  if (!params.toolMetas?.length) {
    return undefined;
  }
  const tools = normalizeUniqueTrimmedStringList(params.toolMetas.map((entry) => entry.toolName));
  const failedToolCalls = params.toolMetas.filter((entry) => entry.isError === true).length;
  return {
    calls: params.toolMetas.length,
    tools,
    // Per-call error metadata is additive to the shipped harness result contract.
    // Keep the prior any-failure signal for external harnesses that do not emit it yet.
    failures: failedToolCalls || Number(Boolean(params.lastToolError)),
    ...(params.lastToolError
      ? { unresolvedError: { toolName: params.lastToolError.toolName } }
      : {}),
  };
}

export function resolveSuccessfulToolNames(
  attempt: Pick<EmbeddedRunAttemptWithReceiptEvidence, "toolMetas" | "successfulNestedToolNames"> &
    Partial<Pick<EmbeddedRunAttemptWithReceiptEvidence, "messagesSnapshot">>,
): string[] {
  const successfulToolNames = normalizeUniqueTrimmedStringList(
    attempt.toolMetas.filter((entry) => entry.isError === false).map((entry) => entry.toolName),
  );
  // A reasoning-only continuation can finish in a new tool-free attempt. Keep
  // receipt evidence from the canonical current turn, never from prior users.
  // Compound Responses ids are opaque: pair the exact full id and tool name.
  const snapshot = attempt.messagesSnapshot ?? [];
  const latestUser = snapshot.findLastIndex((message) => message.role === "user");
  const calls = new Map<string, string | null>();
  for (const message of snapshot.slice(latestUser + 1)) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || !block.id || !block.name) {
          continue;
        }
        // Reused/duplicate ids cannot unambiguously identify a canonical call.
        calls.set(block.id, calls.has(block.id) ? null : block.name);
      }
    } else if (
      message.role === "toolResult" &&
      message.isError === false &&
      calls.get(message.toolCallId) === message.toolName &&
      !successfulToolNames.includes(message.toolName)
    ) {
      successfulToolNames.push(message.toolName);
    }
  }
  const missingNestedToolNames = normalizeUniqueTrimmedStringList(attempt.successfulNestedToolNames)
    .filter((name) => !successfulToolNames.includes(name))
    .toSorted();
  successfulToolNames.push(...missingNestedToolNames);
  return successfulToolNames;
}
