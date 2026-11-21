import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent, resolveExtraParams } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

vi.mock("./logger.js", () => ({
  log: {
    isEnabled: () => false,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => extraParamsTesting.setProviderRuntimeDepsForTest());
afterEach(() => extraParamsTesting.resetProviderRuntimeDepsForTest());

function createStreamAgent() {
  const underlying = vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: vi.fn(async function* () {}),
  })) as unknown as StreamFn;
  const agent = { streamFn: underlying };
  return { underlying, agent };
}

function modelConfig(
  ref: string,
  params: Record<string, unknown>,
  defaults?: Record<string, unknown>,
): OpenClawConfig {
  return { agents: { defaults: { params: defaults, models: { [ref]: { params } } } } };
}

function sample(
  override?: Record<string, unknown>,
  cfg?: OpenClawConfig,
  options?: NonNullable<Parameters<StreamFn>[2]> & { topP?: number },
  provider = "openai",
  id = "gpt-5.4",
) {
  const { underlying, agent } = createStreamAgent();
  applyExtraParamsToAgent(agent, cfg, provider, id, override);
  void agent.streamFn(
    makeProviderModelFixture({ id, api: "openai-completions", provider, baseUrl: "" }),
    { messages: [], tools: [] },
    options,
  );
  expect(underlying).toHaveBeenCalledTimes(1);
  return vi.mocked(underlying).mock.calls[0]?.[2];
}

describe("createStreamFnWithExtraParams sampling overrides", () => {
  it.each([
    { temperature: 0.4, topP: 0.7, maxTokens: 512 },
    { frequencyPenalty: 0.8, presencePenalty: 0.3, seed: 12345 },
    { stop: ["User:", "Assistant:"] },
  ])("forwards request overrides to stream options: %j", (override) => {
    const expected = structuredClone(override);
    expect(sample(override)).toMatchObject(expected);
  });

  it.each([
    [{ top_p: 0.3 }, undefined, undefined, 0.3],
    [{ topP: 0.3 }, undefined, undefined, 0.3],
    [{ top_p: 0 }, undefined, undefined, 0],
    [{ topP: 0.7, top_p: 0.3 }, undefined, undefined, 0.7],
    [{ top_p: 0.3 }, { topP: 0.8 }, undefined, 0.8],
    [{ top_p: 0.3 }, undefined, { topP: 0.9 }, 0.9],
  ] as const)(
    "projects configured nucleus sampling with request precedence: %j",
    (params, override, options, expected) => {
      expect(
        sample(override, modelConfig("local/model", params), options, "local", "model"),
      ).toMatchObject({ topP: expected });
    },
  );

  it.each([false, true])("forwards configured streaming=%s to the transport", (streaming) => {
    const callOptions = sample(
      undefined,
      modelConfig("local/model", { streaming }),
      undefined,
      "local",
      "model",
    );
    expect(callOptions).toMatchObject({ streaming });
  });

  it("canonicalizes token aliases with config precedence before preparing stream params", () => {
    const cfg = modelConfig(
      "dashscope/kimi-k2.6",
      { max_completion_tokens: 64_000 },
      {
        maxTokens: 32_000,
      },
    );
    const resolved = resolveExtraParams({
      cfg: {
        agents: { ...cfg.agents, entries: { bot: { params: { max_tokens: 48_000 } } } },
      } as never,
      provider: "dashscope",
      modelId: "kimi-k2.6",
      agentId: "bot",
    });

    expect(resolved?.maxTokens).toBe(48_000);
    expect(resolved).not.toHaveProperty("max_completion_tokens");
    expect(resolved).not.toHaveProperty("max_tokens");
  });

  it("threads a run-scoped responseFormat schema ahead of configured response_format", () => {
    const responseFormat = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    const callOptions = sample(
      { responseFormat },
      modelConfig("openai/gpt-5.4", { response_format: { type: "text" } }),
    );

    expect(callOptions?.responseFormat).toEqual(responseFormat);
  });

  it("projects configured prompt cache TTL with request precedence and rejects invalid values", () => {
    const cfg = modelConfig("openai/gpt-5.4", { promptCacheTtl: "12h" });
    expect(sample(undefined, cfg)?.promptCacheTtl).toBe("12h");
    expect(sample(undefined, cfg, { promptCacheTtl: undefined })?.promptCacheTtl).toBe("12h");
    expect(sample(undefined, cfg, { promptCacheTtl: "30m" })?.promptCacheTtl).toBe("30m");
    expect(sample({ promptCacheTtl: "24h" })?.promptCacheTtl).toBeUndefined();
  });

  it("preserves configured cache retention with an own undefined request option", () => {
    const { underlying, agent } = createStreamAgent();
    applyExtraParamsToAgent(
      agent,
      undefined,
      "anthropic",
      "claude-sonnet-5",
      { cacheRetention: "long" },
      undefined,
      undefined,
      undefined,
      { supportsPromptCacheKey: true } as never,
    );
    const requestOptions = { cacheRetention: undefined };
    expect(requestOptions).toHaveProperty("cacheRetention");
    void agent.streamFn?.(
      { id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" } as never,
      { messages: [], tools: [] },
      requestOptions,
    );
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(vi.mocked(underlying).mock.calls[0]?.[2]?.cacheRetention).toBe("long");
  });
});

describe("cacheRetention default behavior", () => {
  it("respects legacy cacheControlTtl config", () => {
    expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "anthropic")).toBe("long");
  });

  it("defaults to 'short' for anthropic-vertex without explicit config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("short");
  });
});

describe("extra-params: Google thinking payload compatibility", () => {
  beforeEach(() => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => params.context.extraParams,
    });
  });

  it("lets higher-precedence cachedContent override lower-precedence cached_content", () => {
    const { options } = runExtraParamsCase({
      cfg: modelConfig(
        "google/gemini-2.5-pro",
        { cachedContent: "cachedContents/model-cache" },
        {
          cached_content: "cachedContents/default-cache",
        },
      ),
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-2.5-pro",
      } as unknown as Model<"openai-completions">,
      payload: { contents: [] },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/model-cache",
    );
  });
});

describe("request-local Responses reasoning overrides", () => {
  it.each([
    {
      api: "openai-responses",
      compat: { supportedReasoningEfforts: ["none", "high"] },
      allowed: true,
    },
    {
      api: "openai-responses",
      compat: { supportsReasoningEffort: false, supportedReasoningEfforts: ["none"] },
      allowed: false,
    },
    { api: "openai-responses", compat: { supportedReasoningEfforts: ["high"] }, allowed: false },
    { api: "openai-completions", compat: { supportedReasoningEfforts: ["none"] }, allowed: false },
    { api: "anthropic-messages", compat: { supportedReasoningEfforts: ["none"] }, allowed: false },
  ])("gates native disabling on $api / $compat", ({ api, compat, allowed }) => {
    const underlying = vi.fn(() => ({
      push() {},
      async result() {
        return undefined;
      },
      async *[Symbol.asyncIterator]() {},
    })) as unknown as StreamFn;
    const owner = { streamFn: underlying };
    const model = {
      id: "moira/brain",
      provider: "finn-coordinator",
      api,
      reasoning: true,
      compat,
    } as never;
    const override = { reasoningEffort: "none", temperature: 0.5 };
    const before = structuredClone(override);
    applyExtraParamsToAgent(
      owner,
      undefined,
      "finn-coordinator",
      "moira/brain",
      override,
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      undefined,
      { preparedExtraParams: override },
    );
    const options = { reasoning: "high", maxTokens: 256, headers: { "x-test": "kept" } } as const;
    void owner.streamFn(model, { messages: [] }, options);
    const calls = (underlying as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const actual = calls[0]?.[2] as Record<string, unknown>;
    expect(actual).toMatchObject({
      temperature: 0.5,
      maxTokens: 256,
      headers: { "x-test": "kept" },
    });
    expect(actual.reasoning).toBe(allowed ? "off" : "high");
    expect(actual.reasoningEffort).toBe(allowed ? "none" : undefined);
    expect(override).toEqual(before);
    expect(options.reasoning).toBe("high");
  });

  it("does not cache request-local reasoning controls across attempts", () => {
    const prepareProviderExtraParams = vi.fn((params) => ({
      ...params.context.extraParams,
      prepared: true,
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: () => undefined,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const prepared = [
      { reasoningEffort: "none", temperature: 0.5 },
      { reasoning: "off", temperature: 0.5 },
      { temperature: 0.5 },
    ].map((extraParamsOverride) =>
      resolvePreparedExtraParams({
        cfg,
        provider: "finn-coordinator",
        modelId: "moira/brain",
        extraParamsOverride,
      }),
    );
    // Native provider-runtime handles prepare independently; request controls
    // must not enter any of the provider preparations or leak to the next attempt.
    expect(prepareProviderExtraParams).toHaveBeenCalledTimes(3);
    expect(prepared[0]).not.toBe(prepared[1]);
    expect(prepared[1]).not.toBe(prepared[2]);
    expect(prepared[0]).toEqual(prepared[1]);
    expect(prepared[1]).toEqual(prepared[2]);
    for (const [call] of prepareProviderExtraParams.mock.calls) {
      expect(call.context.extraParams).not.toHaveProperty("reasoningEffort");
      expect(call.context.extraParams).not.toHaveProperty("reasoning");
    }
    for (const params of prepared) {
      expect(params).not.toHaveProperty("reasoningEffort");
      expect(params).not.toHaveProperty("reasoning");
      expect(params.temperature).toBe(0.5);
    }
  });
});
