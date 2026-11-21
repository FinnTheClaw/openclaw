import { describe, expect, it } from "vitest";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  type OpenAICompletionsOptions,
} from "./openai-completions.js";

const context: Context = {
  messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
};

async function capturePayload(
  compat: Model<"openai-completions">["compat"],
  off: string | null | undefined,
  request: {
    transport?: "direct" | "managed";
    reasoning?: SimpleStreamOptions["reasoning"];
    reasoningEffort?: OpenAICompletionsOptions["reasoningEffort"];
  } = {},
) {
  let payload: unknown;
  const model = {
    id: "mapped-thinking-model",
    name: "Mapped thinking model",
    provider: "synthetic-provider",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 32_000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: off === undefined ? undefined : { off },
    compat,
  } satisfies Model<"openai-completions">;
  const options = {
    apiKey: "synthetic-unused-key",
    reasoningEffort: request.reasoningEffort,
    onPayload(value) {
      payload = value;
      throw new Error("captured before network");
    },
  } satisfies OpenAICompletionsOptions;
  const stream = await (request.transport === "managed"
    ? createOpenAICompletionsTransportStreamFn()(model, context, {
        ...options,
        reasoning: request.reasoning,
      })
    : request.reasoning !== undefined
      ? streamSimpleOpenAICompletions(model, context, { ...options, reasoning: request.reasoning })
      : streamOpenAICompletions(model, context, options));
  const result = await stream.result();
  expect(result.errorMessage).toBe("captured before network");
  return payload;
}

describe("mapped off effort in chat completions", () => {
  it.each([
    { reasoning: "off", supported: true, expected: "none" },
    { reasoning: undefined, supported: true, expected: undefined },
    { reasoning: "high", supported: true, expected: "high" },
    { reasoning: "off", supported: false, expected: undefined },
  ] as const)(
    "simple $reasoning preserves omission with none support=$supported",
    async ({ reasoning, supported, expected }) => {
      const payload = await capturePayload(
        {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: supported
            ? ["none", "low", "medium", "high"]
            : ["low", "medium", "high"],
        },
        undefined,
        { reasoning },
      );
      expect((payload as { reasoning_effort?: string }).reasoning_effort).toBe(expected);
    },
  );

  it("sends an explicit none effort without configuring an omitted-request default", async () => {
    expect(
      await capturePayload({ supportsReasoningEffort: true }, undefined, {
        reasoningEffort: "none",
      }),
    ).toMatchObject({
      reasoning_effort: "none",
    });
  });
});
