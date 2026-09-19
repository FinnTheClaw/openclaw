import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesCompactSystemMessage,
  buildOpenAIResponsesParams,
} from "./openai-responses-params-internal.js";

const reasoningModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

describe("buildOpenAIResponsesCompactSystemMessage", () => {
  it("uses the developer role for reasoning models that support it", () => {
    expect(
      buildOpenAIResponsesCompactSystemMessage(reasoningModel, "Retain the conversation."),
    ).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Retain the conversation." }],
    });
  });

  it("falls back to the system role for xAI's native route, which disables the developer role", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, provider: "xai", baseUrl: "https://api.x.ai/v1" },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });

  it("uses the system role for non-reasoning models", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, reasoning: false },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });
});

describe("buildOpenAIResponsesParams reasoning capabilities", () => {
  const customModel = {
    ...reasoningModel,
    id: "local-reasoner",
    provider: "custom-provider",
    baseUrl: "https://proxy.example.com/v1",
    compat: {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "high"],
    },
  } satisfies Model<"openai-responses">;
  const context = {
    messages: [{ role: "user" as const, content: "Reply briefly.", timestamp: 0 }],
  };

  const legacyOffOptions: NonNullable<Parameters<typeof buildOpenAIResponsesParams>[2]> = {
    // @ts-expect-error Legacy untyped input normalizes off, but the public wire enum rejects it.
    reasoningEffort: "off",
  };

  it.each([
    {
      name: "preserves explicitly supported none on a custom route",
      model: customModel,
      options: { reasoningEffort: "none" },
      expected: { effort: "none" },
    },
    {
      name: "preserves explicit none through the reasoning alias",
      model: customModel,
      options: { reasoning: "none" },
      expected: { effort: "none" },
    },
    {
      name: "maps explicit off to the declared none capability",
      model: customModel,
      options: legacyOffOptions,
      expected: { effort: "none" },
    },
    {
      name: "keeps omitted custom-route options distinct from explicit none",
      model: customModel,
      options: undefined,
      expected: undefined,
    },
    {
      name: "keeps empty custom-route options distinct from explicit none",
      model: customModel,
      options: {},
      expected: undefined,
    },
    {
      name: "preserves supported enabled reasoning",
      model: customModel,
      options: { reasoningEffort: "high" },
      expected: { effort: "high", summary: "auto" },
    },
    {
      name: "keeps unsupported custom-route none omitted",
      model: {
        ...customModel,
        compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
      },
      options: { reasoningEffort: "none" },
      expected: undefined,
    },
    {
      name: "respects explicitly disabled reasoning support",
      model: {
        ...customModel,
        compat: { ...customModel.compat, supportsReasoningEffort: false },
      },
      options: { reasoningEffort: "none" },
      expected: undefined,
    },
    {
      name: "does not infer custom-route none support from a native model name",
      model: { ...reasoningModel, baseUrl: customModel.baseUrl },
      options: { reasoningEffort: "none" },
      expected: undefined,
    },
    {
      name: "preserves the native OpenAI omitted-effort default",
      model: reasoningModel,
      options: undefined,
      expected: { effort: "none" },
    },
    {
      name: "preserves native OpenAI explicit none",
      model: reasoningModel,
      options: { reasoningEffort: "none" },
      expected: { effort: "none" },
    },
  ] satisfies Array<{
    name: string;
    model: Model;
    options: Parameters<typeof buildOpenAIResponsesParams>[2];
    expected: { effort: string; summary?: string } | undefined;
  }>)("$name", ({ model, options, expected }) => {
    const params = buildOpenAIResponsesParams(model, context, options);
    expect(params.reasoning).toEqual(expected);
    if (expected?.effort === "high") {
      expect(params.include).toEqual(["reasoning.encrypted_content"]);
    } else {
      expect(params).not.toHaveProperty("include");
    }
  });
});
