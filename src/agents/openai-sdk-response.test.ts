import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { withOpenAISdkResponse, type OpenAISdkRequest } from "./openai-sdk-response.js";

const model = { provider: "test", id: "model" } as Model;

function successfulRequest<T>(
  data: T,
  init: { status?: number; headers?: HeadersInit } = {},
): OpenAISdkRequest<T> {
  return {
    withResponse: vi.fn(async () => ({
      data,
      response: {
        status: init.status ?? 200,
        headers: new Headers(init.headers),
      },
    })),
  };
}

function rejectedRequest<T>(error: Error): OpenAISdkRequest<T> {
  return { withResponse: vi.fn(async () => await Promise.reject(error)) };
}

describe("OpenAI SDK final response plumbing", () => {
  it("awaits one callback before returning the unchanged streaming data", async () => {
    const order: string[] = [];
    const data = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of ["one", "two", "three"]) {
          order.push(`chunk:${chunk}`);
          yield chunk;
        }
      },
    };
    const resolved = await withOpenAISdkResponse(successfulRequest(data), model, async () => {
      order.push("callback:start");
      await Promise.resolve();
      order.push("callback:end");
    });

    expect(resolved).toBe(data);
    expect(order).toEqual(["callback:start", "callback:end"]);
    const chunks: string[] = [];
    for await (const chunk of resolved) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["one", "two", "three"]);
    expect(order).toEqual([
      "callback:start",
      "callback:end",
      "chunk:one",
      "chunk:two",
      "chunk:three",
    ]);
  });

  it("returns unchanged non-stream data and normalizes final status and headers", async () => {
    const data = { id: "response" };
    const onResponse = vi.fn();
    const resolved = await withOpenAISdkResponse(
      successfulRequest(data, {
        status: 201,
        headers: { "X-Finn-Request-ID": "req_header", "X-Mixed-Case": "value" },
      }),
      model,
      onResponse,
    );

    expect(resolved).toBe(data);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 201,
        headers: { "x-finn-request-id": "req_header", "x-mixed-case": "value" },
      },
      model,
    );
  });

  it("propagates the exact SDK rejection without a callback", async () => {
    const sentinel = new Error("sdk rejection");
    const onResponse = vi.fn();

    await expect(withOpenAISdkResponse(rejectedRequest(sentinel), model, onResponse)).rejects.toBe(
      sentinel,
    );
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("does not invoke fallback when a successful response callback rejects", async () => {
    const callbackError = new Error("callback rejection");
    const fallback = vi.fn();

    await expect(
      withOpenAISdkResponse(
        successfulRequest({ ok: true }),
        model,
        async () => {
          throw callbackError;
        },
        fallback,
      ),
    ).rejects.toBe(callbackError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("emits only the successful fallback response callback", async () => {
    const primaryError = new Error("primary failure");
    const recovered = { async *[Symbol.asyncIterator]() {} };
    const fallbackRequest = successfulRequest(recovered, {
      status: 202,
      headers: { "x-request-id": "fallback" },
    });
    const fallback = vi.fn(() => fallbackRequest);
    const onResponse = vi.fn();

    const result = await withOpenAISdkResponse(
      rejectedRequest(primaryError),
      model,
      onResponse,
      fallback,
    );

    expect(result).toBe(recovered);
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(primaryError);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(
      { status: 202, headers: { "x-request-id": "fallback" } },
      model,
    );
  });

  it("keeps separate calls independently exactly once", async () => {
    const onResponse = vi.fn();
    await withOpenAISdkResponse(successfulRequest("first"), model, onResponse);
    await withOpenAISdkResponse(successfulRequest("second"), model, onResponse);

    expect(onResponse).toHaveBeenCalledTimes(2);
  });
});
