// Coverage for before_agent_finalize revision handling in embedded runs.
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

function finalAnswerAttempt(
  text: string,
  overrides?: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  // Finalize tests need a successful assistant turn with both surfaced text and
  // snapshot content so the runner can decide whether to request a revision.
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: {
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
    ],
    ...overrides,
  });
}

function attemptCall(index: number): {
  prompt?: string;
  transcriptPrompt?: string;
  suppressNextUserMessagePersistence?: boolean;
  beforeAgentFinalizeRevisionAttempts?: number;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected embedded attempt call ${index}`);
  }
  return call[0] as {
    prompt?: string;
    transcriptPrompt?: string;
    suppressNextUserMessagePersistence?: boolean;
    beforeAgentFinalizeRevisionAttempts?: number;
  };
}

function completedToolProgressAttempt(params: {
  id: string;
  command: string;
  text: string;
  revisionReason?: string;
}): EmbeddedRunAttemptResult {
  const toolUse = {
    role: "assistant",
    stopReason: "toolUse",
    provider: "openai",
    model: "gpt-5.5",
    content: [
      {
        type: "toolCall",
        id: params.id,
        name: "exec",
        arguments: { command: params.command },
      },
    ],
  };
  return finalAnswerAttempt(params.text, {
    beforeAgentFinalizeRevisionReason: params.revisionReason,
    toolMetas: [{ toolName: "exec", meta: params.command, replaySafe: false }],
    replayMetadata: {
      hadPotentialSideEffects: true,
      replaySafe: false,
    },
    itemLifecycle: {
      startedCount: 1,
      completedCount: 1,
      activeCount: 0,
    },
    messagesSnapshot: [
      toolUse as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      {
        role: "toolResult",
        toolCallId: params.id,
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: params.text }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
    ],
  });
}

describe("runEmbeddedAgent before_agent_finalize", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_finalize",
    );
  });

  it("passes the finalize revision budget to embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(finalAnswerAttempt("First answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-continue",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgentFinalizeRevisionAttempts: 0,
        maxBeforeAgentFinalizeRevisions: 8,
      }),
    );
  });

  it("turns a revise decision into one more hidden continuation", async () => {
    // Revision prompts are hidden continuations; they must not persist the
    // original user prompt a second time.
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        finalAnswerAttempt("First answer.", {
          beforeAgentFinalizeRevisionReason:
            "Tighten the final wording.\n\nMention the validated behavior.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("Revised answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-revise",
      transcriptPrompt: "canonical current ask",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(0).transcriptPrompt).toBe("canonical current ask");
    expect(attemptCall(1).prompt).toContain("Tighten the final wording.");
    expect(attemptCall(1).prompt).toContain("Mention the validated behavior.");
    expect(attemptCall(1).prompt).not.toContain("hello");
    expect(attemptCall(1).transcriptPrompt).toBeUndefined();
    expect(attemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("renews the bounded finalize budget after a distinct durable mutation", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-a",
          command: "touch /tmp/finalize-progress-first",
          text: "First action completed; continuing.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-b",
          command: "touch /tmp/finalize-progress-second",
          text: "Second action completed; continuing.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("All work is complete."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-progress-renewal",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(attemptCall(1).beforeAgentFinalizeRevisionAttempts).toBe(1);
    expect(attemptCall(2).beforeAgentFinalizeRevisionAttempts).toBe(1);
  });

  it("does not renew the finalize budget for the same repeated tool action", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-a",
          command: "touch /tmp/finalize-progress-same",
          text: "First attempt.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-b",
          command: "touch /tmp/finalize-progress-same",
          text: "Repeated attempt.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("All work is complete."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-no-false-progress",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(attemptCall(1).beforeAgentFinalizeRevisionAttempts).toBe(1);
    expect(attemptCall(2).beforeAgentFinalizeRevisionAttempts).toBe(2);
  });

  it("does not renew the finalize budget for distinct read-only probes", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-read-a",
          command: "wc -l first.py",
          text: "First inspection completed; continuing.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(
        completedToolProgressAttempt({
          id: "call-read-b",
          command: "python3 -m py_compile second.py",
          text: "Second inspection completed; continuing.",
          revisionReason: "Continue the unfinished request.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("All work is complete."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-read-only-no-renewal",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(attemptCall(1).beforeAgentFinalizeRevisionAttempts).toBe(1);
    expect(attemptCall(2).beforeAgentFinalizeRevisionAttempts).toBe(2);
  });

  it("escalates once in-session when the finalize revision budget is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        finalAnswerAttempt("Still inspecting.", {
          beforeAgentFinalizeRevisionExhaustedReason:
            "The tool-bearing turn has no valid terminal completion certificate.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("Recovered and complete."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-exhaustion-recovery",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(1).prompt).toContain("continuation budget was exhausted");
    expect(attemptCall(1).prompt).toContain("Change strategy now");
    expect(attemptCall(1).prompt).toContain("no valid terminal completion certificate");
    expect(attemptCall(1).beforeAgentFinalizeRevisionAttempts).toBe(0);
    expect(attemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("fails closed instead of reporting success after bounded recovery is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        finalAnswerAttempt("Still inspecting.", {
          beforeAgentFinalizeRevisionExhaustedReason: "The request is still unfinished.",
        }),
      )
      .mockResolvedValueOnce(
        finalAnswerAttempt("Still inspecting again.", {
          beforeAgentFinalizeRevisionExhaustedReason: "The request is still unfinished.",
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-exhaustion-fail-closed",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain("could not reach a verified terminal state");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.error?.kind).toBe("incomplete_turn");
  });

  it("keeps finalizing when the attempt accepted a side-effecting revise decision", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Sent."],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Sent." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-side-effect",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry finalize revisions after a timed-out attempt", async () => {
    // A timed-out attempt may have partial assistant text, but asking for a
    // finalize revision would replay an invalid or blocked provider turn.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      finalAnswerAttempt("Late answer.", {
        timedOut: true,
        beforeAgentFinalizeRevisionReason: "Revise the late answer.",
        promptTimeoutOutcome: {
          message: "Request timed out.",
          replayInvalid: true,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
