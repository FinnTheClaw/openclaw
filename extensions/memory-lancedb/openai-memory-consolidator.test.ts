import { describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleFactExtractor,
  OpenAICompatibleMemorySummarizer,
} from "./openai-memory-consolidator.js";

function jsonResponse(value: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OpenAI-compatible memory consolidation client", () => {
  it("requests strict structured fact extraction and validates the result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        facts: [
          {
            factKey: null,
            scope: "global",
            subject: "Juniper",
            predicate: "controls",
            object: "greenhouse irrigation",
            text: "Juniper controls greenhouse irrigation.",
            category: "fact",
            confidence: 0.99,
            authority: 1,
            validFrom: null,
            validTo: null,
          },
        ],
      }),
    );
    const extractor = new OpenAICompatibleFactExtractor({
      baseUrl: "http://memory.local/v1/",
      apiKey: "test-token",
      model: "moira/memory",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const facts = await extractor.extract({
      eventId: "evt-1",
      agentId: "jake",
      role: "user",
      content: "Juniper controls greenhouse irrigation.",
      sourceKind: "message_received",
      observedAt: 1_000,
      contentSha256: "hash",
      metadata: {},
      attempts: 1,
      leaseOwner: "test",
      leaseUntil: 10_000,
    });

    expect(facts).toEqual([
      expect.objectContaining({
        subject: "Juniper",
        predicate: "controls",
        object: "greenhouse irrigation",
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://memory.local/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    expect(body.model).toBe("moira/memory");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    expect(String(body.messages[0].content)).toContain('{"facts":[...]}');
    expect(String(body.messages[1].content)).toContain("untrusted historical data");
  });

  it("accepts a single JSON Markdown fence from compatibility routes", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"facts":[]}\n```' } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const extractor = new OpenAICompatibleFactExtractor({
      baseUrl: "http://memory.local/v1",
      model: "moira/memory",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      extractor.extract({
        eventId: "evt-fenced",
        agentId: "jake",
        role: "user",
        content: "No durable fact here.",
        sourceKind: "message_received",
        observedAt: 1_000,
        contentSha256: "hash",
        metadata: {},
        attempts: 1,
        leaseOwner: "test",
        leaseUntil: 10_000,
      }),
    ).resolves.toEqual([]);
  });

  it("creates temporal summaries through the same bounded model route", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ summary: "Juniper controls irrigation and uses circuit C." }),
    );
    const summarizer = new OpenAICompatibleMemorySummarizer({
      baseUrl: "http://memory.local/v1",
      model: "moira/memory",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const summary = await summarizer.summarize(
      {
        nodeId: "sum-1",
        agentId: "jake",
        scope: "global",
        level: "day",
        bucketStart: 0,
        bucketEnd: 86_400_000,
        summaryText: "",
        sourceCount: 2,
        sourceGeneration: 2,
        summarizedGeneration: 0,
        targetGeneration: 2,
        attempts: 1,
        leaseOwner: "test",
        leaseUntil: 10_000,
        updatedAt: 1_000,
      },
      ["Juniper controls irrigation.", "Juniper uses circuit C."],
    );
    expect(summary).toBe("Juniper controls irrigation and uses circuit C.");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(String(body.messages[0].content)).toContain('{"summary":"compact factual summary"}');
  });

  it("rejects malformed model output so the durable lease can retry", async () => {
    const extractor = new OpenAICompatibleFactExtractor({
      baseUrl: "http://memory.local/v1",
      model: "moira/memory",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ facts: [{ subject: "missing fields" }] }),
      ) as typeof fetch,
    });
    await expect(
      extractor.extract({
        eventId: "evt-2",
        agentId: "jake",
        role: "user",
        content: "bad output test",
        sourceKind: "message_received",
        observedAt: 1_000,
        contentSha256: "hash",
        metadata: {},
        attempts: 1,
        leaseOwner: "test",
        leaseUntil: 10_000,
      }),
    ).rejects.toThrow("facts.0.predicate");
  });
});
