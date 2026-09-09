import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../transports/openai-completions-params.js";
import { buildOpenAIResponsesParams } from "../transports/openai-responses-params-internal.js";
import type { Model } from "../types.js";
import { buildBaseOptions, clampMaxTokensToModel } from "./simple-options.js";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 9_000,
    ...overrides,
  };
}

describe("simple completion response format", () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" }, pattern: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  it.each([true, false, undefined])(
    "retains an explicit format with strict=%s through both OpenAI wire shapes",
    (strict) => {
      const jsonSchema = {
        name: "typed_answer",
        schema,
        ...(strict === undefined ? {} : { strict }),
      };
      const responseFormat = { type: "json_schema", json_schema: jsonSchema };
      const model = makeModel({
        api: "openai-completions",
        compat: { supportsJsonSchemaResponseFormat: true },
      });
      const options = buildBaseOptions(model, { responseFormat });
      const context = { messages: [], tools: [] };
      expect(options.responseFormat).toBe(responseFormat);
      expect(buildOpenAICompletionsParams(model, context, options).response_format).toEqual(
        responseFormat,
      );
      expect(
        buildOpenAIResponsesParams({ ...model, api: "openai-responses" }, context, options).text
          ?.format,
      ).toEqual({
        ...jsonSchema,
        type: "json_schema",
      });
    },
  );

  it("maps a raw schema to a named Responses text format without changing the schema", () => {
    const model = makeModel({ api: "openai-responses" });
    const params = buildOpenAIResponsesParams(model, { messages: [] }, { responseFormat: schema });
    expect(params.text?.format).toEqual({ type: "json_schema", name: "openclaw_response", schema });
    expect(schema).not.toHaveProperty("strict");
  });

  it("preserves native flat Responses formats and omitted formats", () => {
    const model = makeModel({ api: "openai-responses" });
    const responseFormat = { type: "json_schema", name: "native_answer", strict: true, schema };
    expect(
      buildOpenAIResponsesParams(model, { messages: [] }, { responseFormat }).text?.format,
    ).toEqual(responseFormat);
    expect(buildBaseOptions(model).responseFormat).toBeUndefined();
    expect(buildOpenAIResponsesParams(model, { messages: [] }, {}).text?.format).toBeUndefined();
  });
});

describe("simple stream max-token clamp", () => {
  it("leaves a request below the model output limit unchanged", () => {
    expect(clampMaxTokensToModel(makeModel(), 512)).toBe(512);
  });

  it("clamps an excessive request to the model output limit", () => {
    expect(clampMaxTokensToModel(makeModel(), 90_000)).toBe(9_000);
  });

  it("keeps a valid floor for a non-positive request", () => {
    expect(clampMaxTokensToModel(makeModel(), 0)).toBe(1);
  });

  it("preserves an omitted output limit", () => {
    expect(clampMaxTokensToModel(makeModel(), undefined)).toBeUndefined();
    expect(buildBaseOptions(makeModel()).maxTokens).toBeUndefined();
  });
});
