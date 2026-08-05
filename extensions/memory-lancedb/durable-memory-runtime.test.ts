import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableMemoryRuntime } from "./durable-memory-runtime.js";

function embedding(text: string, dimensions = 8): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index++) {
    vector[text.charCodeAt(index) % dimensions]! += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

describe("DurableMemoryRuntime", () => {
  let tmpDir = "";
  let runtime: DurableMemoryRuntime | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "durable-memory-runtime-"));
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function open(): DurableMemoryRuntime {
    runtime = new DurableMemoryRuntime({
      ledgerPath: path.join(tmpDir, "ledger.sqlite3"),
      projectionPath: path.join(tmpDir, "projection"),
      vectorDimensions: 8,
      embeddings: { embed: async (text) => embedding(text) },
      logger: {},
      projectionBatch: 16,
      projectionConcurrency: 4,
    });
    return runtime;
  }

  it("commits inbound memory before asynchronous projection and then drains cleanly", async () => {
    const memory = open();
    expect(
      memory.captureInbound({
        agentId: "jake",
        sessionKey: "agent:jake:signal:family",
        channel: "signal",
        conversationId: "family",
        content: "The orchard irrigation controller is named Juniper.",
        timestamp: 100,
        messageId: "signal-1",
      }),
    ).toBe(true);
    expect(memory.ledger.getStats()).toMatchObject({ events: 1, pendingProjection: 1 });

    expect(await memory.flush()).toBe(true);
    expect(memory.ledger.getStats()).toMatchObject({ events: 1, pendingProjection: 0 });
    expect((await memory.index.getStats()).rows).toBe(1);
  });

  it("incrementally reconciles transcript JSONL and never reimports completed lines", async () => {
    const memory = open();
    const transcript = path.join(tmpDir, "agents", "jake", "sessions", "session-1.jsonl");
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    const first = [
      JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-08-05T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        id: "outer-1",
        timestamp: "2026-08-05T00:00:01Z",
        message: {
          role: "user",
          content: "Juniper controls orchard irrigation.",
          timestamp: 1_000,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "outer-2",
        timestamp: "2026-08-05T00:00:02Z",
        message: { role: "assistant", content: "I will remember that.", timestamp: 2_000 },
      }),
    ].join("\n");
    await fs.writeFile(transcript, `${first}\n`, "utf8");

    expect(await memory.reconcileTranscript({ file: transcript, agentId: "jake" })).toMatchObject({
      lines: 3,
      captured: 2,
      reset: true,
    });
    expect(await memory.reconcileTranscript({ file: transcript, agentId: "jake" })).toMatchObject({
      lines: 0,
      captured: 0,
      reset: false,
    });

    await fs.appendFile(
      transcript,
      `${JSON.stringify({
        type: "message",
        id: "outer-3",
        timestamp: "2026-08-05T00:00:03Z",
        message: { role: "user", content: "The pump is on circuit C.", timestamp: 3_000 },
      })}\n`,
      "utf8",
    );
    expect(await memory.reconcileTranscript({ file: transcript, agentId: "jake" })).toMatchObject({
      lines: 1,
      captured: 1,
      reset: false,
    });
    expect(memory.ledger.getStats()).toMatchObject({ events: 3 });
  });

  it("replays unprojected durable events after a clean runtime restart", async () => {
    const first = open();
    first.ledger.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The backup well is 180 feet deep.",
      observedAt: 7_000,
      sourceKind: "message_received",
      externalId: "well-depth",
    });
    // Close the ledger without allowing the scheduled embedding worker to be
    // treated as the persistence boundary. The event is already committed.
    first.index.close();
    first.ledger.close();
    runtime = undefined;

    const second = open();
    expect(second.ledger.getStats()).toMatchObject({ events: 1, pendingProjection: 1 });
    second.scheduleProjection();
    expect(await second.flush()).toBe(true);
    expect(second.ledger.getStats()).toMatchObject({ events: 1, pendingProjection: 0 });
    expect((await second.index.getStats()).rows).toBe(1);
  });

  it("embeds projection batches without one model request per memory", async () => {
    const batches: string[][] = [];
    runtime = new DurableMemoryRuntime({
      ledgerPath: path.join(tmpDir, "ledger.sqlite3"),
      projectionPath: path.join(tmpDir, "projection"),
      vectorDimensions: 8,
      embeddings: {
        embed: async () => {
          throw new Error("single embedding path must not be used");
        },
        embedBatch: async (texts) => {
          batches.push([...texts]);
          return texts.map((text) => embedding(text));
        },
      },
      logger: {},
      projectionBatch: 16,
      projectionConcurrency: 4,
    });
    for (let index = 0; index < 40; index++) {
      runtime.captureInbound({
        agentId: "jake",
        content: `Random durable fact ${index}`,
        timestamp: index + 1,
        messageId: `batch-${index}`,
      });
    }

    expect(await runtime.flush()).toBe(true);
    expect(batches.flat()).toHaveLength(40);
    expect(batches.every((batch) => batch.length <= 16)).toBe(true);
    expect(batches.length).toBeLessThanOrEqual(3);
  });
});
