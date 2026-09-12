import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import { buildAttemptReplayMetadata } from "../embedded-agent-runner/run/attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { EmptySettledTurnFinalizationError } from "./settled-turn-finalization-outcome.js";
import {
  assertSettledTurnFinalizationResult,
  projectSettledTurnFinalizationAttemptResult,
} from "./settled-turn-finalization-result.js";
import type { AgentHarnessSettledTurnFinalizationResult } from "./types.js";

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function safeResult(): AgentHarnessSettledTurnFinalizationResult {
  return {
    assistant: assistantMessage([{ type: "text", text: "done" }]),
  };
}

function successfulAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const assistant = safeResult().assistant;
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [assistant],
    assistantTexts: ["done"],
    toolMetas: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

describe("assertSettledTurnFinalizationResult", () => {
  it("accepts one capability-free final answer", () => {
    const result = safeResult();
    expect(assertSettledTurnFinalizationResult(result)).toBe(result);
  });

  it("rejects a tool call", () => {
    expect(() =>
      assertSettledTurnFinalizationResult({
        assistant: assistantMessage(
          [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
          "toolUse",
        ),
      }),
    ).toThrow("returned a tool call");
  });

  it("classifies a normally completed empty answer", () => {
    const result = {
      assistant: assistantMessage([{ type: "text", text: "  " }]),
    };

    try {
      assertSettledTurnFinalizationResult(result);
      throw new Error("expected completed-empty classification");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySettledTurnFinalizationError);
      expect((error as EmptySettledTurnFinalizationError).result).toBe(result);
    }
  });

  it("classifies the budget-stress reasoning-only length shape as typed empty", () => {
    // b1024-R09: a settled finalizer exhausted its budget with reasoning but no visible text.
    const result = {
      assistant: assistantMessage(
        [{ type: "thinking", thinking: "Reasoning consumed the answer budget." }],
        "length",
      ),
    };
    try {
      assertSettledTurnFinalizationResult(result);
      throw new Error("expected typed empty finalization");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySettledTurnFinalizationError);
      expect((error as EmptySettledTurnFinalizationError).result).toBe(result);
    }
    expect(() =>
      assertSettledTurnFinalizationResult({ ...result, assistantMessageIndex: -1 }),
    ).toThrow("invalid assistant message index");
    expect(() =>
      assertSettledTurnFinalizationResult({
        assistant: assistantMessage(
          [{ type: "toolCall", id: "unfinished", name: "exec", arguments: {} }],
          "length",
        ),
      }),
    ).toThrow("returned a tool call");
  });

  it.each(["error", "aborted"] as const)(
    "does not reclassify an empty %s as retryable finalization",
    (stopReason) => {
      expect(() =>
        assertSettledTurnFinalizationResult({ assistant: assistantMessage([], stopReason) }),
      ).toThrow(`unsuccessful stop reason: ${stopReason}`);
    },
  );

  it("classifies an intentionally silent answer as completed-empty", () => {
    const result = {
      assistant: assistantMessage([{ type: "text", text: "NO_REPLY" }]),
    };

    expect(() => assertSettledTurnFinalizationResult(result)).toThrow(
      EmptySettledTurnFinalizationError,
    );
  });

  it.each(["length", "error", "aborted"] as const)(
    "rejects an assistant with unsuccessful %s stop reason",
    (stopReason) => {
      expect(() =>
        assertSettledTurnFinalizationResult({
          assistant: assistantMessage([{ type: "text", text: "partial" }], stopReason),
        }),
      ).toThrow(`unsuccessful stop reason: ${stopReason}`);
    },
  );

  it("rejects an invalid transcript index", () => {
    expect(() =>
      assertSettledTurnFinalizationResult({ ...safeResult(), assistantMessageIndex: -1 }),
    ).toThrow("invalid assistant message index");
  });

  it("rejects future result fields until their semantics are reviewed", () => {
    expect(() =>
      assertSettledTurnFinalizationResult({
        ...safeResult(),
        futureCapabilityEvidence: true,
      } as AgentHarnessSettledTurnFinalizationResult),
    ).toThrow("unsupported result field: futureCapabilityEvidence");
  });

  it("projects a successful full attempt into the narrow result", () => {
    const attempt = successfulAttempt({ lastAssistantTextMessageIndex: 2 });

    expect(projectSettledTurnFinalizationAttemptResult(attempt)).toEqual({
      assistant: attempt.currentAttemptCompletedAssistant,
      assistantMessageIndex: 2,
    });
  });

  it("rejects a failed full attempt even when it contains visible assistant text", () => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(
        successfulAttempt({
          terminal: { kind: "failed", source: "prompt", error: new Error("provider failed") },
        }),
      ),
    ).toThrow("did not complete successfully");
  });

  it("rejects a full attempt that compacted before producing its answer", () => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(successfulAttempt({ compactionCount: 1 })),
    ).toThrow("did not complete successfully");
  });

  it.each([false, true, undefined])(
    "keeps a completed answer after rejected exec only with executionStarted=%s proof",
    (executionStarted) => {
      const assistant = assistantMessage([
        { type: "text", text: "demo is Cedar; archive is Birch." },
      ]);
      const attempt = successfulAttempt({
        currentAttemptCompletedAssistant: assistant,
        messagesSnapshot: [
          assistantMessage(
            [
              {
                type: "toolCall",
                id: "rejected-exec",
                name: "exec",
                arguments: { command: "echo demo" },
              },
            ],
            "toolUse",
          ),
          {
            role: "toolResult",
            toolCallId: "rejected-exec",
            toolName: "exec",
            content: [{ type: "text", text: "Tool exec not found" }],
            isError: true,
            timestamp: 1,
          },
          assistant,
        ],
        toolMetas: [
          {
            toolName: "exec",
            toolCallId: "rejected-exec",
            replaySafe: false,
            isError: true,
            ...(executionStarted === undefined ? {} : { executionStarted }),
          },
        ],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastToolError: { toolName: "exec", error: "Tool exec not found" },
      });

      attempt.currentAttemptReplayMetadata = buildAttemptReplayMetadata(attempt);
      if (executionStarted === false) {
        expect(projectSettledTurnFinalizationAttemptResult(attempt)).toEqual({ assistant });
      } else {
        expect(() => projectSettledTurnFinalizationAttemptResult(attempt)).toThrow(
          "reported capability activity",
        );
      }
    },
  );

  it.each([
    { itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 } },
    { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    { lastToolError: { toolName: "write", error: "another tool failed" } },
    { replayMetadata: { replaySafe: false, hadPotentialSideEffects: true } },
  ])("rejects unexplained activity alongside a rejected request: %j", (extra) => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(
        successfulAttempt({
          toolMetas: [{ toolName: "exec", executionStarted: false, isError: true }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          ...extra,
        }),
      ),
    ).toThrow("reported capability activity");
  });

  it("rejects canonical capability evidence from a full attempt", () => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(
        successfulAttempt({
          toolMetas: [{ toolName: "write" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      ),
    ).toThrow("reported capability activity");
  });

  it.each(["replayMetadata", "currentAttemptReplayMetadata"] as const)(
    "rejects replay-unsafe %s from a full attempt",
    (field) => {
      expect(() =>
        projectSettledTurnFinalizationAttemptResult(
          successfulAttempt({ [field]: { hadPotentialSideEffects: false, replaySafe: false } }),
        ),
      ).toThrow("reported capability activity");
    },
  );

  it("rejects partial or stale assistants without current-attempt completion evidence", () => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(
        successfulAttempt({ currentAttemptCompletedAssistant: undefined }),
      ),
    ).toThrow("no completed assistant message");
  });
});
