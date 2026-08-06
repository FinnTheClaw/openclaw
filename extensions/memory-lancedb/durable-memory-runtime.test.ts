import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableMemoryRuntime, type WorkspaceMemoryArtifact } from "./durable-memory-runtime.js";

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

  function artifact(
    absolutePath: string,
    relativePath = path.basename(absolutePath),
    kind = "daily-note",
  ): WorkspaceMemoryArtifact {
    return {
      kind,
      workspaceDir: tmpDir,
      relativePath,
      absolutePath,
      agentIds: ["jake"],
      contentType: "markdown",
    };
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

  it("length-buckets mixed transcript rows before padded embedding allocation", async () => {
    const paddedSurfaces: number[] = [];
    runtime = new DurableMemoryRuntime({
      ledgerPath: path.join(tmpDir, "ledger.sqlite3"),
      projectionPath: path.join(tmpDir, "projection"),
      vectorDimensions: 8,
      embeddings: {
        embed: async () => {
          throw new Error("single embedding path must not be used");
        },
        embedBatch: async (texts) => {
          const paddedSurface = Math.max(...texts.map((text) => text.length)) * texts.length;
          paddedSurfaces.push(paddedSurface);
          if (paddedSurface > 120_000) {
            throw new Error("simulated MPS padded-batch OOM");
          }
          return texts.map((text) => embedding(text));
        },
      },
      logger: {},
      projectionBatch: 32,
      projectionConcurrency: 4,
    });
    const lengths = [26_162, 15_776, 14_992, 14_931, 14_901, ...Array(27).fill(12)];
    lengths.forEach((length, index) => {
      runtime!.captureInbound({
        agentId: "jake",
        content: String(index % 10).repeat(length),
        timestamp: index + 1,
        messageId: `mixed-length-${index}`,
      });
    });

    expect(await runtime.flush()).toBe(true);
    expect(paddedSurfaces.length).toBeGreaterThan(1);
    expect(Math.max(...paddedSurfaces)).toBeLessThanOrEqual(120_000);
    expect((await runtime.index.getStats()).rows).toBe(lengths.length);
  });

  it("recursively isolates one failed embedding without retrying successful siblings", async () => {
    runtime = new DurableMemoryRuntime({
      ledgerPath: path.join(tmpDir, "ledger.sqlite3"),
      projectionPath: path.join(tmpDir, "projection"),
      vectorDimensions: 8,
      embeddings: {
        embed: async () => {
          throw new Error("single embedding path must not be used");
        },
        embedBatch: async (texts) => {
          if (texts.some((text) => text.includes("POISON"))) {
            throw new Error("simulated row-specific embedding failure");
          }
          return texts.map((text) => embedding(text));
        },
      },
      logger: {},
      projectionBatch: 16,
      projectionConcurrency: 4,
    });
    for (let index = 0; index < 8; index++) {
      runtime.captureInbound({
        agentId: "jake",
        content: index === 3 ? "POISON" : `Healthy durable fact ${index}`,
        timestamp: index + 1,
        messageId: `isolated-failure-${index}`,
      });
    }

    expect(await runtime.flush(100)).toBe(false);
    expect(runtime.ledger.getStats()).toMatchObject({ retryProjection: 1 });
    expect((await runtime.index.getStats()).rows).toBe(7);
  });

  it("checkpoint-imports Markdown, chunks large sources, and retracts changed or removed sources", async () => {
    const memory = open();
    const root = path.join(tmpDir, "MEMORY.md");
    const daily = path.join(tmpDir, "memory", "2026-08-05.md");
    await fs.mkdir(path.dirname(daily), { recursive: true });
    await fs.writeFile(root, `# Canonical\n\n${"Juniper irrigation detail. ".repeat(400)}`, "utf8");
    await fs.writeFile(daily, "# Daily\n\nThe pump controller is on circuit C.", "utf8");
    const artifacts = [
      artifact(root, "MEMORY.md", "memory-root"),
      artifact(daily, "memory/2026-08-05.md"),
    ];

    const first = await memory.reconcileWorkspaceMarkdown(artifacts);
    expect(first).toMatchObject({ files: 2, changed: 2, unchanged: 0, removed: 0, errors: 0 });
    expect(first.captured).toBeGreaterThan(2);
    expect(await memory.flush()).toBe(true);
    expect((await memory.index.getStats()).rows).toBe(first.captured);

    expect(await memory.reconcileWorkspaceMarkdown(artifacts)).toMatchObject({
      files: 2,
      changed: 0,
      unchanged: 2,
      captured: 0,
      errors: 0,
    });

    await fs.writeFile(root, "# Canonical\n\nJuniper now controls both orchard pumps.", "utf8");
    const changed = await memory.reconcileWorkspaceMarkdown(artifacts);
    expect(changed).toMatchObject({ changed: 1, unchanged: 1, captured: 1, errors: 0 });
    expect(await memory.flush()).toBe(true);
    expect(
      memory.ledger.listRecentEvents({ agentId: "jake", limit: 100 }).map((event) => event.content),
    ).toEqual(expect.arrayContaining(["# Canonical\n\nJuniper now controls both orchard pumps."]));
    expect(
      memory.ledger
        .listRecentEvents({ agentId: "jake", limit: 100 })
        .some((event) => event.content.includes("Juniper irrigation detail")),
    ).toBe(false);

    expect(
      await memory.reconcileWorkspaceMarkdown([artifacts[0]!], {
        activeWorkspaceDirs: [tmpDir],
      }),
    ).toMatchObject({
      files: 1,
      removed: 0,
      preserved: 1,
      errors: 0,
    });
    await fs.rm(daily);
    expect(
      await memory.reconcileWorkspaceMarkdown([artifacts[0]!], {
        activeWorkspaceDirs: [tmpDir],
      }),
    ).toMatchObject({ files: 1, removed: 1, preserved: 0, errors: 0 });
    expect(
      memory.ledger
        .listRecentEvents({ agentId: "jake", limit: 100 })
        .some((event) => event.content.includes("circuit C")),
    ).toBe(false);
  });

  it("imports more than 256 Markdown sources with no rolling file ceiling", async () => {
    const memory = open();
    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const artifacts = await Promise.all(
      Array.from({ length: 300 }, async (_, index) => {
        const file = path.join(memoryDir, `fact-${index}.md`);
        await fs.writeFile(file, `Fact ${index}: durable value ${index * 17}.`, "utf8");
        return artifact(file, `memory/fact-${index}.md`);
      }),
    );

    expect(await memory.reconcileWorkspaceMarkdown(artifacts)).toMatchObject({
      files: 300,
      changed: 300,
      captured: 300,
      errors: 0,
    });
    expect(await memory.reconcileWorkspaceMarkdown(artifacts)).toMatchObject({
      files: 300,
      changed: 0,
      unchanged: 300,
      captured: 0,
      errors: 0,
    });
  });
});
