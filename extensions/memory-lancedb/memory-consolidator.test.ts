import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HybridMemoryIndex } from "./hybrid-memory-index.js";
import {
  MemoryConsolidator,
  type MemoryFactExtractor,
  type MemorySummarizer,
} from "./memory-consolidator.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

function embedding(text: string, dimensions = 16): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index++) {
    vector[(text.charCodeAt(index) + index) % dimensions]! += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

describe("MemoryConsolidator", () => {
  let tmpDir = "";
  let ledger: TemporalMemoryLedger | undefined;
  let index: HybridMemoryIndex | undefined;
  let consolidator: MemoryConsolidator | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-consolidator-"));
  });

  afterEach(async () => {
    await consolidator?.stop();
    index?.close();
    ledger?.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function open(options: { extractor?: MemoryFactExtractor; summarizer?: MemorySummarizer }) {
    ledger = new TemporalMemoryLedger(path.join(tmpDir, "ledger.sqlite3"));
    index = new HybridMemoryIndex(path.join(tmpDir, "projection"), 16);
    consolidator = new MemoryConsolidator({
      ledger,
      index,
      embeddings: {
        embed: async (text) => embedding(text),
        embedBatch: async (texts) => texts.map((text) => embedding(text)),
      },
      logger: {},
      extractor: options.extractor,
      summarizer: options.summarizer,
      extractionBatch: 16,
      summaryBatch: 16,
    });
    return { ledger, index, consolidator };
  }

  it("extracts immutable facts, summarizes only dirty time buckets, and materializes both", async () => {
    const observedAt = Date.UTC(2026, 7, 5, 12);
    const extractor: MemoryFactExtractor = {
      version: "test-extractor-v1",
      extract: async (event) => [
        {
          subject: "Juniper",
          predicate: "controls",
          object: event.content.includes("orchard")
            ? "orchard irrigation"
            : "greenhouse irrigation",
          text: event.content,
          confidence: 0.99,
          authority: 1,
        },
      ],
    };
    const summarizer: MemorySummarizer = {
      version: "test-summarizer-v1",
      summarize: async (node, sources) => `${node.level}: ${sources.join(" ")}`,
    };
    const memory = open({ extractor, summarizer });
    memory.ledger.appendEvent({
      agentId: "jake",
      role: "user",
      content: "Juniper controls greenhouse irrigation.",
      sourceKind: "message_received",
      externalId: "juniper-v1",
      observedAt,
    });

    memory.consolidator.schedule();
    expect(await memory.consolidator.flush()).toBe(true);
    expect(memory.ledger.findCurrentFacts({ agentId: "jake", subject: "Juniper" })).toEqual([
      expect.objectContaining({ object: "greenhouse irrigation", status: "active" }),
    ]);
    expect(memory.ledger.getStats()).toMatchObject({
      pendingExtraction: 0,
      dirtySummaries: 0,
      pendingMaterialization: 0,
      activeFacts: 1,
    });
    expect((await memory.index.getStats()).rows).toBe(5);

    const results = await memory.index.search({
      queryText: "What does Juniper control?",
      vector: embedding("What does Juniper control?"),
      agentId: "jake",
      validAt: observedAt,
      limit: 5,
    });
    expect(results.some((result) => result.entry.recordType === "fact")).toBe(true);
    expect(results.some((result) => result.entry.recordType === "summary")).toBe(true);
  });

  it("keeps the raw event durable when semantic extraction fails", async () => {
    const memory = open({
      extractor: {
        version: "broken-v1",
        extract: async () => {
          throw new Error("model unavailable");
        },
      },
    });
    memory.ledger.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The backup well is 180 feet deep.",
      sourceKind: "message_received",
      externalId: "well-depth",
    });

    memory.consolidator.schedule();
    expect(await memory.consolidator.flush(50)).toBe(false);
    expect(memory.ledger.getStats()).toMatchObject({
      events: 1,
      pendingExtraction: 1,
      activeFacts: 0,
    });
  });

  it("can rebuild fact projections without an extractor or summarizer", async () => {
    const memory = open({});
    const event = memory.ledger.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The rack PDU is on circuit C.",
      sourceKind: "manual_memory",
      externalId: "rack-pdu",
    }).event;
    memory.ledger.appendFactRevision({
      agentId: "jake",
      subject: "rack PDU",
      predicate: "power_circuit",
      object: "C",
      text: "The rack PDU is on circuit C.",
      sourceEventId: event.eventId,
    });

    memory.consolidator.schedule();
    expect(await memory.consolidator.flush()).toBe(true);
    expect((await memory.index.getStats()).rows).toBe(1);
    expect(memory.ledger.getStats()).toMatchObject({ pendingMaterialization: 0 });
  });
});
