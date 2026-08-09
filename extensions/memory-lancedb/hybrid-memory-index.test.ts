import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deduplicateHybridResults,
  HybridMemoryIndex,
  reciprocalRankFuse,
  type MemoryProjectionEntry,
} from "./hybrid-memory-index.js";

function entry(id: string): MemoryProjectionEntry {
  return {
    id,
    recordType: "fact",
    text: `memory ${id}`,
    vector: [1, 0, 0, 0],
    agentId: "jake",
    scope: "global",
    sessionKey: "",
    channel: "",
    conversationId: "",
    factKey: id,
    category: "fact",
    status: "active",
    importance: 0.5,
    confidence: 0.8,
    authority: 0.8,
    validFrom: 1,
    observedAt: 1,
    sourceEventId: id,
    tags: [],
    updatedAt: 1,
  };
}

function unitVector(index: number, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, column) => (column === index ? 1 : 0));
}

describe("hybrid memory ranking", () => {
  it("combines lexical and dense rankings instead of allowing either list to dominate", () => {
    const both = entry("both");
    const denseOnly = entry("dense-only");
    const lexicalOnly = entry("lexical-only");
    const results = reciprocalRankFuse({
      dense: [
        { entry: denseOnly, rank: 1, rawScore: 0.99 },
        { entry: both, rank: 2, rawScore: 0.9 },
      ],
      lexical: [
        { entry: lexicalOnly, rank: 1, rawScore: 12 },
        { entry: both, rank: 2, rawScore: 10 },
      ],
      limit: 3,
    });
    expect(results[0]?.entry.id).toBe("both");
    expect(results.find((result) => result.entry.id === "both")).toMatchObject({
      denseRank: 2,
      lexicalRank: 2,
    });
  });

  it("prefers a distilled fact over a duplicate raw event", () => {
    const fact = entry("fact");
    fact.text = "Juniper controls greenhouse irrigation.";
    const event = { ...entry("event"), recordType: "event" as const, text: fact.text };
    const results = deduplicateHybridResults(
      [
        { entry: event, score: 0.03 },
        { entry: fact, score: 0.02 },
      ],
      5,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.recordType).toBe("fact");
  });
});

describe("HybridMemoryIndex", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-memory-index-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes thousands of rows without a retention ceiling and performs bounded hybrid recall", async () => {
    const dimensions = 16;
    const db = new HybridMemoryIndex(path.join(tmpDir, "lance"), dimensions);
    const rows = Array.from({ length: 2_000 }, (_, index) => {
      const topic = index % dimensions;
      return {
        id: `fact-${index}`,
        recordType: "fact" as const,
        text:
          index === 1_337
            ? "The heliotrope maintenance cipher is ORCHID-7719."
            : `Synthetic equipment memory ${index} for topic ${topic}.`,
        vector: unitVector(topic, dimensions),
        agentId: "jake",
        scope: "global",
        factKey: `equipment-${index}`,
        category: "fact",
        status: "active" as const,
        importance: index === 1_337 ? 1 : 0.5,
        confidence: 0.9,
        authority: 0.9,
        observedAt: 10_000 + index,
        sourceEventId: `event-${index}`,
      };
    });
    await db.upsertBatch(rows);
    await db.ensureIndices();

    const stats = await db.getStats();
    expect(stats.rows).toBe(2_000);
    expect(stats.indices.some((index) => index.columns.includes("text"))).toBe(true);
    expect(stats.indices.some((index) => index.columns.includes("vector"))).toBe(true);

    const results = await db.search({
      agentId: "jake",
      queryText: "What is the heliotrope maintenance cipher?",
      vector: unitVector(1_337 % dimensions, dimensions),
      limit: 5,
    });
    expect(results).toHaveLength(5);
    expect(results[0]?.entry.id).toBe("fact-1337");
    expect(results[0]?.lexicalRank).toBe(1);
  }, 60_000);

  it("never returns another agent's memory even for identical text and vectors", async () => {
    const db = new HybridMemoryIndex(path.join(tmpDir, "lance"), 4);
    const first = entry("private-a");
    first.agentId = "person-a";
    first.text = "The private recovery phrase is orchid seven.";
    const second = entry("private-b");
    second.agentId = "person-b";
    second.text = first.text;
    await db.upsertBatch([first, second]);

    const personA = await db.search({
      agentId: "person-a",
      queryText: first.text,
      vector: first.vector,
      limit: 10,
    });
    const personB = await db.search({
      agentId: "person-b",
      queryText: second.text,
      vector: second.vector,
      limit: 10,
    });
    expect(personA.map((result) => result.entry.id)).toEqual(["private-a"]);
    expect(personB.map((result) => result.entry.id)).toEqual(["private-b"]);
  });

  it("updates projections idempotently and excludes superseded or future facts", async () => {
    const db = new HybridMemoryIndex(path.join(tmpDir, "lance"), 4);
    await db.upsertBatch([
      {
        id: "active",
        recordType: "fact",
        text: "The active rack is blue.",
        vector: [1, 0, 0, 0],
        agentId: "finn",
        factKey: "rack-color",
        status: "active",
        validFrom: 100,
        observedAt: 100,
      },
      {
        id: "superseded",
        recordType: "fact",
        text: "The old rack was red.",
        vector: [1, 0, 0, 0],
        agentId: "finn",
        factKey: "rack-color",
        status: "superseded",
        validFrom: 1,
        observedAt: 1,
      },
      {
        id: "future",
        recordType: "fact",
        text: "The future rack will be green.",
        vector: [1, 0, 0, 0],
        agentId: "finn",
        factKey: "rack-color",
        status: "active",
        validFrom: 1_000,
        observedAt: 200,
      },
    ]);
    await db.upsertBatch([
      {
        id: "active",
        recordType: "fact",
        text: "The active rack is cobalt blue.",
        vector: [1, 0, 0, 0],
        agentId: "finn",
        factKey: "rack-color",
        status: "active",
        validFrom: 100,
        observedAt: 300,
      },
    ]);

    expect((await db.getStats()).rows).toBe(3);
    const results = await db.search({
      agentId: "finn",
      queryText: "rack color",
      vector: [1, 0, 0, 0],
      validAt: 500,
      limit: 10,
    });
    expect(results.map((result) => result.entry.id)).toEqual(["active"]);
    expect(results[0]?.entry.text).toContain("cobalt");
    expect(await db.delete("active")).toBe(true);
    expect(await db.delete("active")).toBe(false);
    expect((await db.getStats()).rows).toBe(2);
  });
});
