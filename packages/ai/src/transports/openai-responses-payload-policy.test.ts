import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesServerCompactionPlan,
} from "./openai-responses-payload-policy.js";

describe("OpenAI Responses compact threshold", () => {
  it.each([
    {
      name: "uses the active runtime cap for the direct Sol route",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "keeps window-only behavior",
      model: { contextWindow: 400_000 },
      expected: 280_000,
    },
    {
      name: "honors an explicit threshold",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      extraParams: { responsesCompactThreshold: 123_456 },
      expected: 123_456,
    },
    {
      name: "uses the fallback without a known budget",
      model: {},
      expected: 80_000,
    },
    {
      name: "floors a positive numeric threshold",
      model: {},
      extraParams: { responsesCompactThreshold: 123_456.9 },
      expected: 123_456,
    },
    {
      name: "accepts a strict positive integer string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456" },
      expected: 123_456,
    },
    {
      name: "rejects a fractional string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456.9" },
      expected: 80_000,
    },
    {
      name: "rejects a nonfinite threshold",
      model: {},
      extraParams: { responsesCompactThreshold: Number.POSITIVE_INFINITY },
      expected: 80_000,
    },
  ])("$name", ({ model, extraParams, expected }) => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...model,
        },
        extraParams,
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
