// Coverage for bounded continuation after a recoverable read-only tool error.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function readOnlyToolErrorAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["Let me check the active jobs."],
    lastAssistant: {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [
        {
          type: "toolCall",
          id: "call-models-parser",
          name: "exec",
          arguments: { command: "coordinator-query models | python3 -c '...'" },
        },
      ],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    lastToolError: {
      toolName: "exec",
      meta: "coordinator-query models",
      error: "AttributeError: 'list' object has no attribute 'get'",
      mutatingAction: false,
    },
    toolMetas: [
      {
        toolName: "exec",
        meta: "coordinator-query models",
        replaySafe: true,
      },
    ],
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

function finalAnswerAttempt(text: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

describe("runEmbeddedAgent read-only tool-error recovery", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  });

  it("continues once from a failed read-only tool result instead of surfacing it as the reply", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(readOnlyToolErrorAttempt())
      .mockResolvedValueOnce(
        finalAnswerAttempt("The two jobs belonged to the prior test and are tracked."),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-read-only-tool-error-recovery",
      transcriptPrompt: "Are those jobs from the last test?",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const recoveryCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as {
      prompt?: string;
      transcriptPrompt?: string;
      suppressNextUserMessagePersistence?: boolean;
    };
    expect(recoveryCall.prompt).toContain("latest read-only tool call failed");
    expect(recoveryCall.prompt).toContain("do not repeat the identical failing call");
    expect(recoveryCall.transcriptPrompt).toBeUndefined();
    expect(recoveryCall.suppressNextUserMessagePersistence).toBe(true);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.livenessState).not.toBe("blocked");
  });
});
