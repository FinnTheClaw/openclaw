import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { testing } from "./openai-transport-stream.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const request = {
  model: "gpt-5.5",
  stream: true,
  input: [
    {
      type: "reasoning",
      id: "rs_prior",
      encrypted_content: "ciphertext",
      summary: [],
    },
    {
      type: "message",
      id: "msg_prior",
      role: "assistant",
      content: [{ type: "output_text", text: "visible answer" }],
    },
  ],
};

function finalRequest(data: unknown, headers: HeadersInit = {}) {
  return {
    withResponse: vi.fn(async () => ({
      data,
      response: { status: 200, headers: new Headers(headers) },
    })),
  };
}

describe("OpenAI encrypted-content response retry", () => {
  it("retries once and emits only the successful final response", async () => {
    const primaryError = new OpenAI.BadRequestError(
      400,
      {
        code: "thinking_signature_invalid",
        message: "Encrypted content could not be decrypted or parsed.",
        type: "invalid_request_error",
      },
      undefined,
      new Headers(),
    );
    const recoveredStream = { async *[Symbol.asyncIterator]() {} };
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn(async () => await Promise.reject(primaryError)) })
      .mockReturnValueOnce(finalRequest(recoveredStream, { "x-request-id": "recovered" }));
    const onResponse = vi.fn();

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model,
        onResponse,
      }),
    ).resolves.toBe(recoveredStream);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toBe(request);
    expect(create.mock.calls[1]?.[0]).toEqual({
      ...request,
      input: [{ type: "reasoning", id: "rs_prior", summary: [] }, request.input[1]],
    });
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-request-id": "recovered" } },
      model,
    );
  });

  it("propagates callback rejection without retrying a successful primary request", async () => {
    const callbackError = new Error("callback failed");
    const stream = { async *[Symbol.asyncIterator]() {} };
    const create = vi.fn(() => finalRequest(stream));

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model,
        onResponse: async () => {
          throw callbackError;
        },
      }),
    ).rejects.toBe(callbackError);
    expect(create).toHaveBeenCalledOnce();
  });
});
