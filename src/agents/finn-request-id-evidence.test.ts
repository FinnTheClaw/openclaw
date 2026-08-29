import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";
import {
  createFinnRequestEvidenceCollector,
  readFinnRequestId,
  requireFinnRequestIdEvidence,
  wrapFinnRequestIdEvidence,
  wrapFinnRequestIdEvidenceWithCollector,
} from "./finn-request-id-evidence.js";
import type { StreamFn } from "./runtime/index.js";

type Headers = Record<string, unknown>;

const model = { provider: "local", model: "qwen" } as unknown as Parameters<StreamFn>[0];
const context = { messages: [] } as Parameters<StreamFn>[1];

async function resultOf(stream: ReturnType<StreamFn>) {
  return (await stream).result();
}

function sourceWithResponse(headers: Headers, delayMs = 0): StreamFn {
  return (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options?.onResponse?.({ status: 200, headers } as never, model as never);
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
    expect(requireFinnRequestIdEvidence(result)).toBe("req_alpha-42");
    expect(onResponse).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(JSON.stringify(result)).not.toContain("x-unrelated");
  });

  it.each([undefined, "", "request-1", " req_trimmed", "req_has spaces", "req_\nforged"])(
    "omits malformed or missing evidence (%p) without failing the agent turn",
    async (value) => {
      const headers = value === undefined ? {} : { "x-finn-request-id": value };
      const result = await resultOf(
        wrapFinnRequestIdEvidence(sourceWithResponse(headers))(model, context),
      );

      expect(result.finnRequestIds).toBeUndefined();
      expect(result.finnRequestIdEvidenceComplete).toBeUndefined();
      expect(() => requireFinnRequestIdEvidence(result)).toThrow(
        "Expected exactly one complete X-Finn-Request-Id evidence item",
      );
    },
  );

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

  it("retains ordered multiplicity for retries and makes certification reject it", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const source = vi
      .fn()
      .mockImplementationOnce(sourceWithResponse({ "x-finn-request-id": "req_first" }))
      .mockImplementationOnce(sourceWithResponse({ "x-finn-request-id": "req_second" }));
    const wrapped = wrapFinnRequestIdEvidenceWithCollector(source, collector);

    await resultOf(wrapped(model, context));
    const retried = await resultOf(wrapped(model, context));

    expect(retried.finnRequestIds).toEqual(["req_first", "req_second"]);
    expect(retried.finnRequestIdEvidenceComplete).toBe(true);
    expect(() => requireFinnRequestIdEvidence(retried)).toThrow(
      "Expected exactly one complete X-Finn-Request-Id evidence item",
    );
  });

  it("threads a turn collector through the embedded agent stream resolver", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const resolved = resolveEmbeddedAgentStreamFn({
      currentStreamFn: sourceWithResponse({ "x-finn-request-id": "req_resolved" }),
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
    expect(() => requireFinnRequestIdEvidence(result)).toThrow(
      "Expected exactly one complete X-Finn-Request-Id evidence item",
    );
  });

  it("leaves non-Finn response evidence absent", async () => {
    const result = await resultOf(
      wrapFinnRequestIdEvidence(
        sourceWithResponse({ "x-request-id": "provider-123", "x-other": "safe" }),
      )(model, context),
    );

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
    expect(readFinnRequestId({ "x-request-id": "provider-123" })).toBeUndefined();
  });
});
