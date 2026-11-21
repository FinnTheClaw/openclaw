import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  resolveNonVisibleTurnRetryInstructions,
  resolveReasoningOnlyRetryStreamParams,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue the original user request from the current state. Perform any remaining authorized work using available tools as needed, then report the actual outcome rather than only a plan. Preserve completed work; do not repeat it or restart from scratch. If your completed actions already answered the request, answer exactly NO_REPLY.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "Your turn ended without a final reply. Continue the original user request, perform remaining authorized work with available tools as needed, and report the actual outcome. Answer the user's request now. Do not repeat completed actions or restart the task. Do not restate your reasoning.";

function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

function emptyAttempt(assistant = emptyAssistant()) {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

function turnState(
  attempt: Parameters<typeof resolveNonVisibleTurnRetryInstructions>[0]["attempt"] = emptyAttempt(),
) {
  return { payloadCount: 0, aborted: false, timedOut: false, attempt };
}

function retryInstructions(
  overrides: Partial<Parameters<typeof resolveNonVisibleTurnRetryInstructions>[0]> = {},
) {
  return resolveNonVisibleTurnRetryInstructions({
    ...turnState(overrides.attempt),
    settledToolPayloadCount: 0,
    replyDeliveryState: "missing",
    ...overrides,
  });
}

function isSilent(
  attempt: EmbeddedRunAttemptResult,
  terminalReplyExpectation: "required" | "optional" = "optional",
) {
  return shouldTreatEmptyAssistantReplyAsSilent({
    ...turnState(attempt),
    allowEmptyAssistantReplyAsSilent: true,
    terminalReplyExpectation,
  });
}

describe("incomplete-turn recovery policy", () => {
  it("does not request a visible continuation for an authored speech-only answer", () => {
    const assistant = emptyAssistant({
      content: [
        { type: "thinking", thinking: "Prepare a spoken greeting.", thinkingSignature: "" },
        { type: "text", text: "" },
      ],
      openclawDelivery: { tts: { tagged: true, text: "Have a lovely day." } },
    });

    expect(
      retryInstructions({
        modelApi: "openai-completions",
        attempt: emptyAttempt(assistant),
      })[0],
    ).toBeNull();
  });

  it.each([
    { terminalReplyExpectation: "required", owner: "unfinished lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "async tool" },
    { terminalReplyExpectation: "optional", owner: "active lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "unfinished lifecycle item" },
  ] as const)(
    "honors silence without cancelling $owner (reply=$terminalReplyExpectation)",
    ({ terminalReplyExpectation, owner }) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [
          { toolName: "image_generate", asyncStarted: owner === "async tool", replaySafe: false },
        ],
        itemLifecycle: {
          startedCount: 1,
          completedCount: owner === "async tool" ? 1 : 0,
          activeCount: owner === "active lifecycle item" ? 1 : 0,
        },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const state = turnState(attempt);
      // Outward silence does not prove delivery or authorize replaying pending work.
      expect(isSilent(attempt, terminalReplyExpectation)).toBe(true);
      expect(retryInstructions(state)[1]).toBeNull();
      expect(payloadText(attempt)).toBeNull();
    },
  );

  it.each([
    { name: "visible terminal stop", text: "The final answer.", stopReason: "stop" },
    { name: "failed terminal sentinel", text: "NO_REPLY", stopReason: "error" },
    { name: "media-bearing sentinel", text: "NO_REPLY\nMEDIA:/tmp/image.png", stopReason: "stop" },
    { name: "aborted terminal sentinel", text: "NO_REPLY", stopReason: "aborted" },
  ] as const)("does not revive earlier silence after $name", ({ text, stopReason }) => {
    const assistant = emptyAssistant({ content: [{ type: "text", text }], stopReason });
    const attempt = emptyAttempt(assistant);
    attempt.assistantTexts = ["NO_REPLY"];
    expect(isSilent(attempt)).toBe(false);
    if (stopReason === "error") {
      expect(payloadText(attempt)).toBe("No answer was returned. Ask again if you still need one.");
    }
  });

  it("does not treat a tool-call preamble as a silent final", () => {
    const assistant = emptyAssistant({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "NO_REPLY" },
        { type: "toolCall", id: "send", name: "message", arguments: {} },
      ],
    });
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        ...turnState(emptyAttempt(assistant)),
        terminalReplyExpectation: "optional",
      }),
    ).toBe(false);
  });

  it.each([
    ["anthropic", "claude-opus-4.7", "messages"],
    ["google-vertex", "google/gemini-3.1-flash", undefined],
  ] as const)(
    "returns the visible-answer prompt for an empty %s turn",
    (provider, modelId, modelApi) => {
      const assistant = emptyAssistant({
        provider,
        model: provider === "google-vertex" ? "gemini-3.1-flash" : modelId,
        content: provider === "anthropic" ? [] : [{ type: "text", text: "" }],
        usage: createZeroUsageFixture(),
      });
      expect(
        retryInstructions({
          provider,
          modelId,
          modelApi,
          attempt: emptyAttempt(assistant),
        })[1],
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(retryInstructions({ provider: "openai", modelId: "gpt-5.4", attempt })[1]).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      retryInstructions({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        attempt: emptyAttempt(assistant),
      })[0],
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });
});

function payloadText(attempt: EmbeddedRunAttemptResult, payloadCount = 0) {
  return resolveIncompleteTurnPayloadText({
    ...turnState(attempt),
    payloadCount,
    externalAbort: false,
  });
}

describe("reasoning-only retry stream params", () => {
  const modelParams = { chat_template_kwargs: { enable_thinking: true, model_option: "kept" } };
  it.each([0, 1, 3])("leaves attempt %s unchanged", (reasoningOnlyAttempts) => {
    const streamParams = { temperature: 0.5 };
    expect(
      resolveReasoningOnlyRetryStreamParams({
        modelApi: "openai-completions",
        reasoningOnlyAttempts,
        modelParams,
        streamParams,
      }),
    ).toBe(streamParams);
  });
  it.each([undefined, false, "true"])(
    "requires explicit model opt-in, not %s",
    (enable_thinking) => {
      expect(
        resolveReasoningOnlyRetryStreamParams({
          modelApi: "openai-completions",
          reasoningOnlyAttempts: 2,
          modelParams: { chat_template_kwargs: { enable_thinking } },
          defaultParams: modelParams,
        }),
      ).toBeUndefined();
    },
  );
  it("uses a native request-local Responses override", () => {
    expect(
      resolveReasoningOnlyRetryStreamParams({
        modelApi: "openai-responses",
        reasoningOnlyAttempts: 2,
        modelParams,
      }),
    ).toEqual({ reasoningEffort: "none" });
  });
  it("preserves kwargs and request controls without mutating inputs", () => {
    const streamParams = {
      temperature: 0.5,
      tool_choice: "auto",
      chatTemplateKwargs: { request_option: "kept" },
    };
    const before = structuredClone({ modelParams, streamParams });
    expect(
      resolveReasoningOnlyRetryStreamParams({
        modelApi: "openai-completions",
        reasoningOnlyAttempts: 2,
        modelParams,
        defaultParams: { chat_template_kwargs: { default_option: 1 } },
        agentParams: { chatTemplateKwargs: { agent_option: 2 } },
        streamParams,
      }),
    ).toEqual({
      ...streamParams,
      chat_template_kwargs: {
        default_option: 1,
        model_option: "kept",
        agent_option: 2,
        request_option: "kept",
        enable_thinking: false,
      },
    });
    expect({ modelParams, streamParams }).toEqual(before);
  });
  it("accepts the configured camel-case alias", () => {
    expect(
      resolveReasoningOnlyRetryStreamParams({
        modelApi: "openai-completions",
        reasoningOnlyAttempts: 2,
        modelParams: { chatTemplateKwargs: { enable_thinking: true } },
      }),
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

// Exercise the actual managed transport and SDK serialization, not a payload stand-in.

it("continues fully settled effects to finish the original task without replaying calls", () => {
  const call = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "settled-write", name: "write", arguments: {} }],
  });
  const final = emptyAssistant({ content: [{ type: "thinking", thinking: "More work remains." }] });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    currentAttemptAssistant: final,
    lastAssistant: final,
    messagesSnapshot: [
      { role: "user", content: "Write both files.", timestamp: 1 },
      call,
      {
        role: "toolResult",
        toolCallId: "settled-write",
        toolName: "write",
        content: [{ type: "text", text: "first written" }],
        isError: false,
        timestamp: 2,
      },
      final,
    ],
    toolMetas: [
      { toolName: "write", toolCallId: "settled-write", isError: false, replaySafe: false },
    ],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
  const [, continuation] = retryInstructions({ modelApi: "openai-completions", attempt });
  expect(continuation).toContain("using tools for any remaining work");
  expect(continuation).toContain("Do not repeat completed tool calls");
});
