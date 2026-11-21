import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesRequestContextTokens,
  resolveOpenAIResponsesServerCompactionPlan as compactionPlan,
} from "./openai-responses-payload-policy.js";

const nativeModel = {
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const plan = (model: Record<string, unknown> = {}, params?: Record<string, unknown>) =>
  compactionPlan({ ...nativeModel, ...model }, params);

describe("OpenAI Responses request context", () => {
  it.each([
    { fastMode: undefined, expected: 260_000 },
    { fastMode: () => undefined, expected: 260_000 },
    { fastMode: "auto", expected: 260_000 },
    { fastMode: false, expected: undefined },
    { fastMode: true, expected: undefined },
    { fastMode: "ultrafast", expected: undefined },
  ])(
    "preserves authored tiers but restricts explicit speed: $fastMode",
    ({ fastMode, expected }) => {
      expect(
        resolveOpenAIResponsesRequestContextTokens(
          { provider: "openai", api: "openai-responses" },
          { serviceTier: "ultrafast", fastMode },
          ["default", "priority"],
        ),
      ).toBe(expected);
    },
  );
});

describe("OpenAI Responses compact threshold", () => {
  it.each([
    { params: { fastMode: "ultrafast" }, threshold: 260_000 },
    { params: { fast_mode: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: () => "ultrafast" }, threshold: 260_000 },
    { params: { serviceTier: "ultrafast", fastMode: false }, threshold: 700_000 },
    { params: { service_tier: "ultrafast" }, threshold: 260_000 },
    { params: { fastMode: true }, threshold: 700_000 },
    { params: { fastMode: false }, threshold: 700_000 },
    { params: { fastMode: "auto" }, threshold: 700_000 },
    { params: { fastMode: "ultrafast", serviceTier: "priority" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "default" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "flex" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", serviceTier: "auto" }, threshold: 260_000 },
    { params: { fastMode: "ultrafast", responsesCompactThreshold: 120_000 }, threshold: 120_000 },
  ])("resolves tier/config precedence for $params", ({ params, threshold }) => {
    const model = { contextWindow: 1_050_000, contextTokens: 922_000 };
    expect(plan(model, { responsesCompactThreshold: 700_000, ...params }).threshold).toBe(
      threshold,
    );
  });

  it("keeps disabled compaction disabled under Ultrafast", () => {
    expect(
      plan(
        {},
        {
          fastMode: "ultrafast",
          responsesServerCompaction: false,
        },
      ),
    ).toEqual({ enabled: false, threshold: undefined });
  });

  it.each([
    [
      "active runtime cap",
      { contextWindow: 1_050_000, contextTokens: 272_000 },
      undefined,
      190_400,
    ],
    ["window-only", { contextWindow: 400_000 }, undefined, 280_000],
    ["explicit threshold", { contextWindow: 1_050_000, contextTokens: 272_000 }, 123_456, 123_456],
    ["unknown budget", {}, undefined, 80_000],
    ["floor numeric threshold", {}, 123_456.9, 123_456],
    ["integer string", {}, "123456", 123_456],
    ["fractional string", {}, "123456.9", 80_000],
    ["nonfinite threshold", {}, Number.POSITIVE_INFINITY, 80_000],
  ] as const)("resolves %s", (_name, model, responsesCompactThreshold, expected) => {
    expect(
      plan(
        model,
        responsesCompactThreshold === undefined ? undefined : { responsesCompactThreshold },
      ).threshold,
    ).toBe(expected);
  });
});

describe("OpenAI Responses stateless reasoning policy", () => {
  const customModel = {
    api: "openai-responses",
    provider: "finn-coordinator",
    id: "moira/brain",
    baseUrl: "http://coordinator.internal/v1",
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
    },
  };

  it.each(["low", "medium", "high", "none"])(
    "preserves effort %s and visible reasoning while stripping encrypted include/replay",
    (effort) => {
      const input = [
        {
          type: "reasoning",
          id: "rs_visible",
          encrypted_content: "opaque-state",
          summary: [{ type: "summary_text", text: "Visible reasoning summary" }],
        },
        { type: "reasoning", id: "rs_opaque", encrypted_content: "opaque-only", summary: [] },
        { type: "message", role: "user", content: "Continue", encrypted_content: "user-data" },
        { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"encrypted_content":"tool-data","result":42}',
        },
      ];
      const originalInput = structuredClone(input);
      const payload: Record<string, unknown> = {
        store: false,
        include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
        reasoning: { effort, summary: "auto" },
        input,
        temperature: 0.4,
        max_output_tokens: 128,
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
      };
      applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(customModel));
      expect(payload).not.toHaveProperty("store");
      expect(payload.include).toEqual(["message.output_text.logprobs"]);
      expect(payload.reasoning).toEqual({ effort, summary: "auto" });
      expect(payload.input).toEqual([
        { type: "reasoning", id: "rs_visible", summary: originalInput[0].summary },
        ...originalInput.slice(2),
      ]);
      expect(payload.temperature).toBe(0.4);
      expect(payload.max_output_tokens).toBe(128);
      expect(payload.text).toEqual({
        format: { type: "json_schema", name: "answer", schema: { type: "object" } },
      });
      expect(input).toEqual(originalInput);
    },
  );

  it("omits an encrypted-only include without affecting unencrypted summaries", () => {
    const payload: Record<string, unknown> = {
      include: ["reasoning.encrypted_content"],
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Keep me" }] }],
    };
    applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(customModel));
    expect(payload).not.toHaveProperty("include");
    expect(payload.input).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Keep me" }] },
    ]);
  });

  it("keeps visible reasoning content even without a summary", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          type: "reasoning",
          encrypted_content: "opaque",
          content: [{ type: "text", text: "Visible" }],
        },
      ],
    };
    applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(customModel));
    expect(payload.input).toEqual([
      { type: "reasoning", content: [{ type: "text", text: "Visible" }] },
    ]);
  });

  it.each([undefined, true])(
    "preserves native OpenAI encrypted state with supportsStore=%s and per-request store:false",
    (supportsStore) => {
      const payload: Record<string, unknown> = {
        store: false,
        reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        input: [{ type: "reasoning", encrypted_content: "native-state", summary: [] }],
      };
      const original = structuredClone(payload);
      const policy = resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          compat: supportsStore === undefined ? undefined : { supportsStore },
        },
        { storeMode: "disable" },
      );
      expect(policy.shouldStripEncryptedReasoningState).toBe(false);
      applyOpenAIResponsesPayloadPolicy(payload, policy);
      expect(payload).toEqual(original);
    },
  );

  it("does not apply the stateless Responses opt-out to a Chat model", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy({
      ...customModel,
      api: "openai-completions",
    });
    expect(policy.shouldStripEncryptedReasoningState).toBe(false);
  });
});
