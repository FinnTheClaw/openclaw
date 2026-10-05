import { createServer } from "node:http";
import { createLlmRuntime } from "@openclaw/ai";
import { Agent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../../test/helpers/openai-responses-sse.js";
import type { Context, Model, SimpleStreamOptions } from "../../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  resolveReasoningOnlyRetryStreamParams,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue the original user request from the current state. Perform any remaining authorized work using available tools as needed, then report the actual outcome rather than only a plan. Preserve completed work; do not repeat it or restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue the original user request from that partial turn. Perform any remaining authorized work using available tools as needed, then report the actual outcome rather than only a plan. Preserve completed work; do not repeat it, restate the reasoning, or restart from scratch.";

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

describe("incomplete-turn recovery policy", () => {
  it.each(
    (["required", "optional"] as const).flatMap((terminalReplyExpectation) =>
      ["async tool", "active lifecycle item", "unfinished lifecycle item"].map((owner) => ({
        terminalReplyExpectation,
        owner,
      })),
    ),
  )(
    "keeps $owner out of completed silence (reply=$terminalReplyExpectation)",
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
      const state = { payloadCount: 0, aborted: false, timedOut: false, attempt };
      // Silence must not steal completion ownership from background work. Nor
      // may it trigger a replay or a spurious warning while that owner continues.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          ...state,
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation,
        }),
      ).toBe(false);
      expect(resolveEmptyResponseRetryInstruction(state)).toBeNull();
      expect(resolveIncompleteTurnPayloadText({ ...state, externalAbort: false })).toBeNull();
    },
  );

  it.each([
    { name: "visible terminal stop", text: "The final answer.", stopReason: "stop" },
    { name: "failed terminal sentinel", text: "NO_REPLY", stopReason: "error" },
    { name: "aborted terminal sentinel", text: "NO_REPLY", stopReason: "aborted" },
  ] as const)("does not revive earlier silence after $name", ({ text, stopReason }) => {
    const assistant = emptyAssistant({ content: [{ type: "text", text }], stopReason });
    const attempt = emptyAttempt(assistant);
    attempt.assistantTexts = ["NO_REPLY"];
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
    if (stopReason === "error") {
      expect(
        resolveIncompleteTurnPayloadText({
          payloadCount: 0,
          aborted: false,
          externalAbort: false,
          timedOut: false,
          attempt,
        }),
      ).toContain("couldn't generate a response");
    }
  });

  it.each([
    { name: "a completed reaction", aborted: false, timedOut: false, yielded: false, error: false },
    { name: "a failed reaction", aborted: false, timedOut: false, yielded: false, error: true },
    { name: "an aborted turn", aborted: true, timedOut: false, yielded: false, error: false },
    { name: "a timed-out turn", aborted: false, timedOut: true, yielded: false, error: false },
    { name: "pending work", aborted: false, timedOut: false, yielded: true, error: false },
  ])(
    "classifies optional NO_REPLY after $name without replay",
    ({ aborted, timedOut, yielded, error }) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "message", meta: "react", replaySafe: false, isError: error }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        ...(yielded ? { yieldDetected: true } : {}),
        ...(error ? { lastToolError: { toolName: "message", error: "reaction failed" } } : {}),
      });
      // Optional replies can tolerate completed effects, but never replay them
      // or take completion ownership from failed, cancelled, or pending work.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          allowEmptyAssistantReplyAsSilent: false,
          terminalReplyExpectation: "optional",
          payloadCount: 0,
          aborted,
          timedOut,
          attempt,
        }),
      ).toBe(!aborted && !timedOut && !yielded && !error);
      expect(
        resolveEmptyResponseRetryInstruction({
          payloadCount: 0,
          aborted,
          timedOut,
          attempt,
        }),
      ).toBeNull();
    },
  );

  it.each([
    {
      name: "zero-token Anthropic stop",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      modelApi: "messages",
      assistant: buildEmbeddedRunnerAssistant({
        provider: "anthropic",
        model: "claude-opus-4.7",
        content: [],
        usage: createZeroUsageFixture(),
      }),
    },
    {
      name: "Anthropic-compatible positive-output stop",
      provider: "sub2api",
      modelId: "claude-opus-4-7",
      modelApi: "anthropic-messages",
      assistant: emptyAssistant({
        api: "anthropic-messages",
        provider: "sub2api",
        model: "claude-opus-4-7",
        usage: {
          input: 2048,
          output: 3100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5148,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    {
      name: "generic empty Gemini turn",
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      modelApi: undefined,
      assistant: emptyAssistant({
        stopReason: "stop",
        provider: "google-vertex",
        model: "gemini-3.1-flash",
      }),
    },
  ])(
    "returns the visible-answer prompt for $name",
    ({ provider, modelId, modelApi, assistant }) => {
      expect(
        resolveEmptyResponseRetryInstruction({
          provider,
          modelId,
          modelApi,
          payloadCount: 0,
          aborted: false,
          timedOut: false,
          attempt: emptyAttempt(assistant),
        }),
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(
      resolveEmptyResponseRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      resolveReasoningOnlyRetryInstruction({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("treats reply-optional post-tool empty stops as silent after side effects", () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "required",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "tool failure",
      attempt: makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        toolMetas: [
          { toolName: "sessions", meta: "patch failed", replaySafe: false, isError: true },
        ],
        lastToolError: { toolName: "sessions", error: "patch failed" },
        lastAssistant: emptyAssistant(),
      }),
      aborted: false,
    },
    {
      name: "assistant error",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: false,
    },
    {
      name: "caller abort",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: true,
    },
  ])("does not treat $name as intentional silence", ({ attempt, aborted }) => {
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("settles a heartbeat reasoning-only stop as silence under its declared contract", () => {
    const assistant = emptyAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "heartbeat_rs", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
  });
});

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
describe("custom Responses reasoning wire contracts", () => {
  const supportsNone = {
    supportsStore: false,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["none", "low", "medium", "high"],
  };
  it.each([
    {
      name: "omits undeclared off for moira/brain",
      compat: undefined,
      level: "off",
      expected: undefined,
    },
    {
      name: "sends declared off as native none",
      compat: supportsNone,
      level: "off",
      expected: { effort: "none" },
    },
    {
      name: "keeps enabled reasoning",
      compat: supportsNone,
      level: "high",
      expected: { effort: "high", summary: "auto" },
    },
    {
      name: "omits incompatible off",
      compat: { supportsReasoningEffort: false },
      level: "off",
      expected: undefined,
    },
  ] as const)("$name through Agent and real HTTP", async ({ compat, level, expected }) => {
    const result = await captureCustomResponsesWire({ compat, thinkingLevel: level });
    expect(result.payload.reasoning).toEqual(expected);
    expect(result.options.reasoning).toBe(level);
  });

  it("sends native reasoningEffort none directly without mutating request controls", async () => {
    const controls = { reasoningEffort: "none", temperature: 0.5, maxTokens: 128 };
    const before = structuredClone(controls);
    const result = await captureCustomResponsesWire({
      compat: supportsNone,
      nativeOptions: controls,
    });
    expect(result.payload).toMatchObject({
      reasoning: { effort: "none" },
      temperature: 0.5,
      max_output_tokens: 128,
    });
    expect(controls).toEqual(before);
  });

  it.each([{ reasoningEffort: "none" }, { reasoning: "off" }])(
    "forwards the request-local native disabling override for %j",
    async (override) => {
      const controls = { ...override, temperature: 0.5, maxTokens: 128 };
      const before = structuredClone(controls);
      const result = await captureCustomResponsesWire({
        compat: supportsNone,
        thinkingLevel: "high",
        extraParamsOverride: controls,
      });
      expect(result.options).toMatchObject({ reasoningEffort: "none", reasoning: "off" });
      expect(result.payload).toMatchObject({
        reasoning: { effort: "none" },
        temperature: 0.5,
        max_output_tokens: 128,
      });
      expect(controls).toEqual(before);
    },
  );
  it.each([0, 1, 2, 3])(
    "keeps the Responses fallback local to retry %s",
    async (reasoningOnlyAttempts) => {
      const modelParams = { chat_template_kwargs: { enable_thinking: true, model_option: "kept" } };
      const streamParams = {
        temperature: 0.5,
        maxTokens: 128,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            strict: true,
            schema: {
              type: "object",
              properties: { answer: { type: "number" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      };
      const before = structuredClone({ modelParams, streamParams });
      const override = resolveReasoningOnlyRetryStreamParams({
        modelApi: "openai-responses",
        reasoningOnlyAttempts,
        modelParams,
        streamParams,
      });
      if (reasoningOnlyAttempts !== 2) {
        expect(override).toBe(streamParams);
      }
      const result = await captureCustomResponsesWire({
        compat: supportsNone,
        thinkingLevel: "high",
        extraParamsOverride: override,
      });
      expect(result.payload.reasoning).toEqual(
        reasoningOnlyAttempts === 2 ? { effort: "none" } : { effort: "high", summary: "auto" },
      );
      expect(result.payload).toMatchObject({
        temperature: 0.5,
        max_output_tokens: 128,
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            strict: true,
            schema: streamParams.response_format.json_schema.schema,
          },
        },
      });
      expect({ modelParams, streamParams }).toEqual(before);
    },
  );

  it.each([undefined, false, "true"])(
    "requires explicit Responses model opt-in (%s)",
    (enable_thinking) => {
      const streamParams = { temperature: 0.5 };
      expect(
        resolveReasoningOnlyRetryStreamParams({
          modelApi: "openai-responses",
          reasoningOnlyAttempts: 2,
          modelParams: { chat_template_kwargs: { enable_thinking } },
          defaultParams: { chat_template_kwargs: { enable_thinking: true } },
          streamParams,
        }),
      ).toBe(streamParams);
    },
  );

  it.each(["anthropic-messages", "openai-chatgpt-responses", "azure-openai-responses", undefined])(
    "leaves incompatible API %s unchanged",
    (modelApi) => {
      const streamParams = { temperature: 0.5 };
      expect(
        resolveReasoningOnlyRetryStreamParams({
          modelApi,
          reasoningOnlyAttempts: 2,
          modelParams: { chatTemplateKwargs: { enable_thinking: true } },
          streamParams,
        }),
      ).toBe(streamParams);
    },
  );

  it.each([
    undefined,
    { supportsReasoningEffort: false },
    { supportedReasoningEfforts: ["low", "high"] },
  ])("does not forward disabling overrides without declared none (%j)", async (compat) => {
    const result = await captureCustomResponsesWire({
      compat,
      thinkingLevel: "high",
      extraParamsOverride: { reasoningEffort: "none" },
    });
    expect(result.options).not.toHaveProperty("reasoningEffort");
    expect(result.options.reasoning).toBe("high");
    expect(result.payload.reasoning).toEqual(
      compat?.supportsReasoningEffort === false ? undefined : { effort: "high", summary: "auto" },
    );
  });
});

describe("stateless custom Responses enabled reasoning wire", () => {
  const compat = {
    supportsStore: false,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["none", "low", "medium", "high"] as const,
  };

  it("keeps native low effort and summary without the rejected encrypted include", async () => {
    const result = await captureCustomResponsesWire({ compat, thinkingLevel: "low" });
    expect(result.payload.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(result.payload).not.toHaveProperty("include");
  });

  it("replays visible reasoning and tool results without encrypted reasoning state", async () => {
    const result = await captureCustomResponsesWire({
      compat,
      nativeOptions: { reasoningEffort: "low" },
      messages: [
        { role: "user", content: "Compute 6*7.", timestamp: 0 },
        buildEmbeddedRunnerAssistant({
          api: "openai-responses",
          provider: "finn-coordinator",
          model: "moira/brain",
          content: [
            {
              type: "thinking",
              thinking: "Use the completed computation.",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Use the completed computation." }],
                encrypted_content: "must-not-reach-coordinator",
              }),
            },
            { type: "toolCall", id: "call_42", name: "exec", arguments: { command: "6*7" } },
          ],
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "call_42",
          toolName: "exec",
          content: [{ type: "text", text: "42" }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
    expect(result.payload.reasoning).toEqual({ effort: "low", summary: "auto" });
    const input = result.payload.input as Array<Record<string, unknown>>;
    expect(input).toContainEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Use the completed computation." }],
    });
    expect(input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_42", name: "exec" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_42", output: "42" }),
      ]),
    );
    expect(JSON.stringify(input)).not.toContain("must-not-reach-coordinator");
  });
});

async function captureCustomResponsesWire(params: {
  compat?: Model<"openai-responses">["compat"];
  thinkingLevel?: "off" | "low" | "high";
  messages?: Context["messages"];
  nativeOptions?: Record<string, unknown>;
  extraParamsOverride?: Record<string, unknown>;
}) {
  const requests: Array<{ url: string | undefined; payload: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, payload: JSON.parse(body) });
      writeOpenAiResponsesText(response, {
        text: "wire-ok",
        messageId: "msg_wire",
        responseId: "resp_wire",
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing wire-test address");
    }
    const model: Model<"openai-responses"> = {
      id: "moira/brain",
      name: "Coordinator brain wire fixture",
      api: "openai-responses",
      provider: "finn-coordinator",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 128,
      compat: params.compat,
    };
    const providerStream = resolveEmbeddedAgentStream({
      llmRuntime: createLlmRuntime(),
      currentStreamFn: undefined,
      model,
      sessionId: "custom-responses-wire",
      resolvedApiKey: "synthetic-wire-key",
    }).streamFn;
    let options: SimpleStreamOptions = {};
    const streamFn: StreamFn = (requestModel, context, callOptions) => {
      options = { ...callOptions };
      return providerStream(requestModel, context, {
        ...callOptions,
        apiKey: "synthetic-wire-key",
        cacheRetention: "none",
        transport: "sse",
      });
    };
    const owner = { streamFn };
    if (params.extraParamsOverride) {
      applyExtraParamsToAgent(
        owner,
        undefined,
        model.provider,
        model.id,
        params.extraParamsOverride,
        params.thinkingLevel,
        undefined,
        undefined,
        model,
        undefined,
        undefined,
        { preparedExtraParams: params.extraParamsOverride },
      );
    }
    if (params.nativeOptions) {
      const stream = await owner.streamFn(
        model,
        {
          messages: params.messages ?? [{ role: "user", content: "Return wire-ok.", timestamp: 0 }],
        },
        params.nativeOptions,
      );
      expect((await stream.result()).stopReason).toBe("stop");
    } else {
      const agent = new Agent({
        initialState: { model, thinkingLevel: params.thinkingLevel },
        streamFn: owner.streamFn,
      });
      await agent.prompt("Return wire-ok.");
      expect(agent.state.errorMessage).toBeUndefined();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/responses");
    const payload = requests[0].payload;
    expect(payload.store).not.toBe(true);
    expect(payload).not.toHaveProperty("previous_response_id");
    expect(payload).not.toHaveProperty("chat_template_kwargs");
    const reasoning = payload.reasoning as { effort?: string } | undefined;
    expect(payload.include ?? []).toEqual(
      params.compat?.supportsStore !== false && reasoning?.effort && reasoning.effort !== "none"
        ? ["reasoning.encrypted_content"]
        : [],
    );
    return { payload, options };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
