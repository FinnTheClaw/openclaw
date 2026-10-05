import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesCompactSystemMessage,
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
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

describe("sanitizeOpenAICodexResponsesParams", () => {
  it.each([
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/codex/responses",
  ])("restores stateless Codex payload policy after hooks at %s", (baseUrl) => {
    const codexModel = {
      ...reasoningModel,
      api: "openai-chatgpt-responses",
      baseUrl,
    } satisfies Model;
    const params = sanitizeOpenAICodexResponsesParams(codexModel, {
      model: codexModel.id,
      store: true,
      max_output_tokens: 128,
      metadata: { purpose: "dashboard-title" },
      text: { format: { type: "text" }, verbosity: "low" },
    });

    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("metadata");
    expect(params.text).toEqual({ verbosity: "low" });
  });

  it("does not rewrite non-Codex Responses endpoints", () => {
    const params = sanitizeOpenAICodexResponsesParams(reasoningModel, {
      store: true,
      max_output_tokens: 128,
    });

    expect(params).toEqual({ store: true, max_output_tokens: 128 });
  });
});

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

describe("buildOpenAIResponsesParams structured schema", () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const context = {
    messages: [{ role: "user" as const, content: "Return an answer.", timestamp: 0 }],
  };
  const nativeFormat = { type: "json_schema", name: "answer", strict: true, schema };

  it.each([
    {
      name: "maps a raw llm-task schema to native Responses text.format",
      responseFormat: schema,
      expected: { type: "json_schema", name: "openclaw_response", schema },
    },
    {
      name: "keeps an already native Responses format intact",
      responseFormat: nativeFormat,
      expected: nativeFormat,
    },
    {
      name: "unwraps a Chat Completions schema envelope for Responses",
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true, schema },
      },
      expected: nativeFormat,
    },
  ])("$name", ({ responseFormat, expected }) => {
    const before = JSON.stringify(responseFormat);
    const params = buildOpenAIResponsesParams(reasoningModel, context, {
      responseFormat,
      reasoningEffort: "high",
    });
    expect(params.text?.format).toEqual(expected);
    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(JSON.stringify(responseFormat)).toBe(before);
  });

  it("preserves explicit JSON-object mode without wrapping it as a schema", () => {
    const params = buildOpenAIResponsesParams(reasoningModel, context, {
      responseFormat: { type: "json_object" },
    });
    expect(params.text?.format).toEqual({ type: "json_object" });
  });

  it("does not invent a schema when responseFormat is omitted", () => {
    const params = buildOpenAIResponsesParams(reasoningModel, context, undefined);
    expect(params.text?.format).toBeUndefined();
  });

  it("retains native Codex unsupported-format stripping", () => {
    const model = {
      ...reasoningModel,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } satisfies Model;
    const params = buildOpenAIResponsesParams(model, context, { responseFormat: schema });
    expect(params.text?.format).toBeUndefined();
    expect(params.store).toBe(false);
  });
});
