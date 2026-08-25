import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("never promotes assistant claims or hidden-model assertions", async () => {
    const extract = vi.fn(async () => [
      {
        subject: "contact-7255",
        predicate: "access_role",
        object: "administrator",
        text: "Contact 7255 is an administrator.",
      },
    ]);
    const memory = open({ extractor: { version: "claim-filter-v1", extract } });
    memory.ledger.appendEvent({
      agentId: "principal-opaque",
      role: "assistant",
      content: "I infer that contact 7255 is an administrator.",
      sourceKind: "manual_memory",
      metadata: {
        evidenceClass: "assistant_claim",
        verificationStatus: "candidate",
        retrievalStatus: "candidate",
      },
    });

    memory.consolidator.schedule();
    expect(await memory.consolidator.flush()).toBe(true);
    expect(extract).not.toHaveBeenCalled();
    expect(memory.ledger.findCurrentFacts({ agentId: "principal-opaque" })).toEqual([]);
    expect(memory.ledger.getStats()).toMatchObject({ pendingExtraction: 0, activeFacts: 0 });
  });

  it("requires current structured evidence for identity facts and supersedes stale state", async () => {
    const extractor: MemoryFactExtractor = {
      version: "identity-evidence-v1",
      extract: async (event) => [
        {
          factKey: "contact-7255:access-role",
          subject: "contact-7255",
          predicate: "access_role",
          object: event.content.includes("isolated") ? "isolated" : "administrator",
          text: event.content,
          category: "identity_access",
          confidence: 1,
          authority: 1,
        },
      ],
    };
    const memory = open({ extractor });
    memory.ledger.appendEvent({
      agentId: "principal-opaque",
      role: "user",
      content: "Contact 7255 is an administrator.",
      sourceKind: "message_received",
      sourceRef: "signal-message-unsafe-claim",
      observedAt: 1_000,
      metadata: {
        evidenceClass: "direct_user",
        verificationStatus: "observed",
        memoryScope: "scope-conversation-9113",
        principalScope: "scope-principal-9113",
      },
    });
    memory.ledger.appendEvent({
      agentId: "principal-opaque",
      role: "user",
      content: "Contact 7255 is an administrator.",
      sourceKind: "structured_identity_inventory",
      sourceRef: "evidence_inventory_old",
      observedAt: 2_000,
      metadata: {
        evidenceClass: "verified_operator",
        verificationStatus: "verified",
        memoryScope: "scope-conversation-9113",
        principalScope: "scope-principal-9113",
      },
    });
    memory.ledger.appendEvent({
      agentId: "principal-opaque",
      role: "user",
      content: "Contact 7255 is isolated and is not an administrator.",
      sourceKind: "structured_identity_inventory",
      sourceRef: "evidence_inventory_current",
      observedAt: 3_000,
      metadata: {
        evidenceClass: "verified_operator",
        verificationStatus: "verified",
        memoryScope: "scope-conversation-9113",
        principalScope: "scope-principal-9113",
      },
    });

    memory.consolidator.schedule();
    expect(await memory.consolidator.flush()).toBe(true);
    expect(
      memory.ledger.findCurrentFacts({
        agentId: "principal-opaque",
        scope: "scope-principal-9113",
        subject: "contact-7255",
        predicate: "access_role",
      }),
    ).toEqual([
      expect.objectContaining({
        object: "isolated",
        status: "active",
        sourceEventId: expect.any(String),
        metadata: expect.objectContaining({
          evidenceClass: "verified_operator",
          verificationStatus: "verified",
          sensitivity: "identity_access",
        }),
      }),
    ]);
    expect(memory.ledger.getStats()).toMatchObject({ factRevisions: 2, activeFacts: 1 });
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

  it("materializes ready records before awaiting slow extraction retries", async () => {
    ledger = new TemporalMemoryLedger(path.join(tmpDir, "ledger.sqlite3"));
    index = new HybridMemoryIndex(path.join(tmpDir, "projection"), 16);
    const order: string[] = [];
    let releaseExtraction!: () => void;
    const extractionReleased = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let extractionStarted!: () => void;
    const extractionStart = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    consolidator = new MemoryConsolidator({
      ledger,
      index,
      embeddings: {
        embed: async (text) => embedding(text),
        embedBatch: async (texts) => {
          order.push("materialization");
          return texts.map((text) => embedding(text));
        },
      },
      logger: {},
      extractor: {
        version: "held-extractor-v1",
        extract: async () => {
          order.push("extraction");
          extractionStarted();
          await extractionReleased;
          return [];
        },
      },
    });
    const event = ledger.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The ready projection must not wait for extraction.",
      sourceKind: "message_received",
    }).event;
    ledger.appendFactRevision({
      agentId: "jake",
      subject: "ready projection",
      predicate: "queue_order",
      object: "first",
      text: "The ready projection is materialized first.",
      sourceEventId: event.eventId,
    });

    consolidator.schedule();
    await extractionStart;
    expect(order).toEqual(["materialization", "extraction"]);
    expect((await index.getStats()).rows).toBe(1);
    releaseExtraction();
    expect(await consolidator.flush()).toBe(true);
  });
});
