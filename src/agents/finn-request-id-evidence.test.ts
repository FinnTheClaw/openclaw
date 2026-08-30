import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";
import {
  createFinnRequestEvidenceCollector,
  readFinnRequestId,
  wrapFinnRequestIdEvidenceWithCollector as wrapBoundFinnRequestIdEvidence,
} from "./finn-request-id-evidence.js";
import { markBuiltInProviderTransport } from "./finn-request-id-transport.js";
import type { StreamFn } from "./runtime/index.js";

type Headers = Record<string, unknown>;

const model = {
  provider: "remote-llm",
  id: "moira/brain",
  baseUrl: "http://127.0.0.1:8300/v1",
} as unknown as Parameters<StreamFn>[0];
const nonFinnModel = {
  ...model,
  provider: "custom",
  baseUrl: "https://models.example.test/v1",
} as Parameters<StreamFn>[0];
const context = { messages: [] } as Parameters<StreamFn>[1];

function wrapFinnRequestIdEvidenceWithCollector(
  source: StreamFn,
  collector: ReturnType<typeof createFinnRequestEvidenceCollector>,
): StreamFn {
  markBuiltInProviderTransport(source);
  return wrapBoundFinnRequestIdEvidence(source, collector, {
    selectedStreamFn: source,
    resolvedModel: model,
  });
}

function wrapFinnRequestIdEvidence(source: StreamFn): StreamFn {
  return wrapFinnRequestIdEvidenceWithCollector(source, createFinnRequestEvidenceCollector());
}

function trustedProviderStream(source: StreamFn): StreamFn {
  return markBuiltInProviderTransport(source);
}

async function resultOf(stream: ReturnType<StreamFn>) {
  return (await stream).result();
}

function sourceWithResponse(headers: Headers, delayMs = 0): StreamFn {
  return (responseModel, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options?.onResponse?.({ status: 200, headers } as never, responseModel);
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: "openai-completions" as const,
        provider: "local",
        model: "qwen",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: 0,
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

describe("Finn request-id evidence", () => {
  it("captures only the exact valid coordinator response header", async () => {
    const onResponse = vi.fn();
    const result = await resultOf(
      wrapFinnRequestIdEvidence(
        sourceWithResponse({
          "X-Finn-Request-Id": "req_alpha-42",
          authorization: "Bearer never-serialize",
          "x-unrelated": "untrusted",
        }),
      )(model, context, { onResponse }),
    );

    expect(result.finnRequestIds).toEqual(["req_alpha-42"]);
    expect(result.finnRequestIdEvidenceComplete).toBe(true);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(JSON.stringify(result)).not.toContain("x-unrelated");
  });

  it("preserves exact provider errors from iteration and result", async () => {
    const sentinel = new Error("provider iterator sentinel");
    const source: StreamFn = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw sentinel;
          },
        };
      },
      async result() {
        throw sentinel;
      },
    });
    const wrapped = await wrapFinnRequestIdEvidence(source)(model, context);
    const iterate = async () => {
      for await (const event of wrapped) {
        void event;
      }
    };

    await expect(iterate()).rejects.toBe(sentinel);
    await expect(wrapped.result()).rejects.toBe(sentinel);
  });

  it.each([undefined, "", "request-1", " req_trimmed", "req_has spaces", "req_\nforged"])(
    "marks malformed or missing coordinator evidence incomplete (%p)",
    async (value) => {
      const headers = value === undefined ? {} : { "x-finn-request-id": value };
      const result = await resultOf(
        wrapFinnRequestIdEvidence(sourceWithResponse(headers))(model, context),
      );

      expect(result.finnRequestIds).toEqual([]);
      expect(result.finnRequestIdEvidenceComplete).toBe(false);
    },
  );

  it.each([
    { "X-Finn-Request-Id": "req_one", "x-finn-request-id": "req_two" },
    { "x-finn-request-id": "req_one", "X-FINN-REQUEST-ID": "malformed" },
  ])("rejects duplicate or ambiguous header maps", async (headers) => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(sourceWithResponse(headers))(model, context),
    );

    expect(result.finnRequestIds).toEqual([]);
    expect(result.finnRequestIdEvidenceComplete).toBe(false);
    expect(readFinnRequestId(headers)).toBeUndefined();
  });

  it("keeps request evidence associated with its own concurrent turn", async () => {
    const [slowResult, fastResult] = await Promise.all([
      resultOf(
        wrapFinnRequestIdEvidence(sourceWithResponse({ "x-finn-request-id": "req_slow" }, 15))(
          model,
          context,
        ),
      ),
      resultOf(
        wrapFinnRequestIdEvidence(sourceWithResponse({ "x-finn-request-id": "req_fast" }))(
          model,
          context,
        ),
      ),
    ]);

    expect(slowResult.finnRequestIds).toEqual(["req_slow"]);
    expect(fastResult.finnRequestIds).toEqual(["req_fast"]);
  });

  it.each(["retry", "failover", "replan"])(
    "retains first-seen request order across %s attempts",
    async (mode) => {
      const collector = createFinnRequestEvidenceCollector();
      const first = resolveEmbeddedAgentStreamFn({
        providerStreamFn: trustedProviderStream(
          sourceWithResponse({ "x-finn-request-id": "req_" + mode + "_first" }),
        ),
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: model as never,
        finnRequestEvidence: collector,
      });
      const second = resolveEmbeddedAgentStreamFn({
        providerStreamFn: trustedProviderStream(
          sourceWithResponse({ "x-finn-request-id": "req_" + mode + "_second" }),
        ),
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: model as never,
        finnRequestEvidence: collector,
      });

      await resultOf(first(model, context));
      const result = await resultOf(second(model, context));

      expect(result.finnRequestIds).toEqual(["req_" + mode + "_first", "req_" + mode + "_second"]);
      expect(result.finnRequestIdEvidenceComplete).toBe(true);
    },
  );

  it("threads a turn collector through the embedded agent stream resolver", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const resolved = resolveEmbeddedAgentStreamFn({
      providerStreamFn: trustedProviderStream(
        sourceWithResponse({ "x-finn-request-id": "req_resolved" }),
      ),
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: model as never,
      finnRequestEvidence: collector,
    });

    const result = await resultOf(resolved(model, context));

    expect(result.finnRequestIds).toEqual(["req_resolved"]);
    expect(result.finnRequestIdEvidenceComplete).toBe(true);
  });

  it("preserves a non-Finn stream resolver path without a collector", () => {
    const source = sourceWithResponse({ "x-request-id": "other" });
    const resolved = resolveEmbeddedAgentStreamFn({
      currentStreamFn: source,
      sessionId: "session-1",
      model: model as never,
    });

    expect(resolved).toBe(source);
  });

  it("marks otherwise valid evidence incomplete after a missing response id", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const source = vi
      .fn()
      .mockImplementationOnce(sourceWithResponse({ "x-finn-request-id": "req_first" }))
      .mockImplementationOnce(sourceWithResponse({}));
    const wrapped = wrapFinnRequestIdEvidenceWithCollector(source, collector);

    await resultOf(wrapped(model, context));
    const result = await resultOf(wrapped(model, context));

    expect(result.finnRequestIds).toEqual(["req_first"]);
    expect(result.finnRequestIdEvidenceComplete).toBe(false);
  });

  it("bounds evidence and marks overflow incomplete", async () => {
    const collector = createFinnRequestEvidenceCollector();
    let result;
    for (let index = 0; index < 17; index += 1) {
      const wrapped = wrapFinnRequestIdEvidenceWithCollector(
        sourceWithResponse({ "x-finn-request-id": "req_overflow_" + index }),
        collector,
      );
      result = await resultOf(wrapped(model, context));
    }

    expect(result?.finnRequestIds).toHaveLength(16);
    expect(result?.finnRequestIds?.[0]).toBe("req_overflow_0");
    expect(result?.finnRequestIds?.[15]).toBe("req_overflow_15");
    expect(result?.finnRequestIdEvidenceComplete).toBe(false);
  });

  it("deduplicates request ids without mutating earlier evidence snapshots", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const wrapped = wrapFinnRequestIdEvidenceWithCollector(
      sourceWithResponse({ "x-finn-request-id": "req_repeat" }),
      collector,
    );

    const first = await resultOf(wrapped(model, context));
    const second = await resultOf(wrapped(model, context));

    expect(first.finnRequestIds).toEqual(["req_repeat"]);
    expect(second.finnRequestIds).toEqual(["req_repeat"]);
    expect(first.finnRequestIdEvidenceComplete).toBe(true);
    expect(second.finnRequestIdEvidenceComplete).toBe(true);
  });

  it("ignores caller-supplied request identifiers", async () => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(sourceWithResponse({}))(model, context, {
        headers: {
          "X-Finn-Request-ID": "req_forged-request",
          "x-client-request-id": "req_client-forged",
        },
      }),
    );

    expect(result.finnRequestIds).toEqual([]);
    expect(result.finnRequestIdEvidenceComplete).toBe(false);
  });

  it("ignores a caller-selected expected coordinator origin", async () => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(sourceWithResponse({ "x-finn-request-id": "req_forged-response" }))(
        nonFinnModel,
        context,
        {
          expectedFinnOrigin: "http://127.0.0.1:8300/v1",
        } as never,
      ),
    );

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
  });

  it("leaves non-Finn response evidence absent", async () => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(
        sourceWithResponse({ "x-finn-request-id": "req_forged", "x-other": "safe" }),
      )(nonFinnModel, context),
    );

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
    expect(readFinnRequestId({ "x-request-id": "provider-123" })).toBeUndefined();
  });

  it.each([
    { provider: "custom" },
    { provider: "remote-llm-lookalike" },
    { baseUrl: "https://127.0.0.1:8300/v1" },
    { baseUrl: "http://localhost:8300/v1" },
    { baseUrl: "http://127.0.0.1.evil.test:8300/v1" },
    { baseUrl: "http://user@127.0.0.1:8300/v1" },
    { baseUrl: "http://127.0.0.1:8301/v1" },
    { baseUrl: "http://127.0.0.1:8300/v1/" },
    { baseUrl: "http://127.0.0.1:8300/v1/chat" },
    { baseUrl: "http://127.0.0.1:8300/v1?route=moira/brain" },
    { baseUrl: "http://127.0.0.1:8300/v1#moira/brain" },
    { id: "moira/brain/extra" },
    { id: "other/brain" },
  ])("rejects a non-canonical coordinator identity (%j)", async (override) => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(sourceWithResponse({ "x-finn-request-id": "req_forged" }))(
        { ...model, ...override },
        context,
      ),
    );

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
  });

  it("binds a frozen route identity into each immutable internal snapshot", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const result = await resultOf(
      wrapFinnRequestIdEvidenceWithCollector(
        sourceWithResponse({ "x-finn-request-id": "req_bound" }),
        collector,
      )(model, context),
    );
    const snapshot = collector.snapshot();

    expect(snapshot.requests).toEqual([
      {
        requestId: "req_bound",
        route: {
          provider: "remote-llm",
          baseUrl: "http://127.0.0.1:8300/v1",
          route: "moira/brain",
        },
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.requests)).toBe(true);
    expect(Object.isFrozen(snapshot.requests[0]?.route)).toBe(true);
    expect(Object.isFrozen(result.finnRequestIds)).toBe(true);
    expect(() => (result.finnRequestIds as string[]).push("req_mutated")).toThrow();
    expect(collector.snapshot().requestIds).toEqual(["req_bound"]);
  });

  it("collapses duplicate ids while preserving first-seen order", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const ids = ["req_second", "req_first", "req_second", "req_third", "req_first"];
    let result;
    for (const requestId of ids) {
      result = await resultOf(
        wrapFinnRequestIdEvidenceWithCollector(
          sourceWithResponse({ "x-finn-request-id": requestId }),
          collector,
        )(model, context),
      );
    }

    expect(result?.finnRequestIds).toEqual(["req_second", "req_first", "req_third"]);
    expect(result?.finnRequestIdEvidenceComplete).toBe(true);
  });

  it("leaves pre-response throws and rejections as unfinished attempts", async () => {
    const collector = createFinnRequestEvidenceCollector();
    await resultOf(
      wrapFinnRequestIdEvidenceWithCollector(
        sourceWithResponse({ "x-finn-request-id": "req_prior" }),
        collector,
      )(model, context),
    );
    const syncSentinel = new Error("sync pre-response sentinel");
    const asyncSentinel = new Error("async pre-response sentinel");
    const syncThrow: StreamFn = () => {
      throw syncSentinel;
    };
    const asyncReject: StreamFn = async () => {
      throw asyncSentinel;
    };

    expect(() =>
      wrapFinnRequestIdEvidenceWithCollector(syncThrow, collector)(model, context),
    ).toThrow(syncSentinel);
    await expect(
      wrapFinnRequestIdEvidenceWithCollector(asyncReject, collector)(model, context),
    ).rejects.toBe(asyncSentinel);
    expect(collector.snapshot().requestIds).toEqual(["req_prior"]);
    expect(collector.snapshot().complete).toBe(false);
  });

  it("marks evidence incomplete when fallback leaves the coordinator route", async () => {
    const collector = createFinnRequestEvidenceCollector();
    await resultOf(
      wrapFinnRequestIdEvidenceWithCollector(
        sourceWithResponse({ "x-finn-request-id": "req_primary" }),
        collector,
      )(model, context),
    );
    const fallback = await resultOf(
      wrapFinnRequestIdEvidenceWithCollector(
        sourceWithResponse({ "x-finn-request-id": "req_forged-fallback" }),
        collector,
      )(nonFinnModel, context),
    );

    expect(fallback.finnRequestIds).toEqual(["req_primary"]);
    expect(fallback.finnRequestIdEvidenceComplete).toBe(false);
  });
});
