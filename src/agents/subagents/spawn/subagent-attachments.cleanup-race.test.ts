import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializeSubagentAttachments } from "./subagent-attachments.js";

const gate = vi.hoisted(() => ({
  wait: Promise.resolve(),
  finished: Promise.resolve(),
  failObserved: () => {},
  finish: () => {},
  pending: false,
}));

vi.mock("../../../infra/private-file-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/private-file-store.js")>();
  return {
    ...actual,
    privateFileStore(root: string) {
      const store = actual.privateFileStore(root);
      return {
        ...store,
        async writeText(name: string, content: string | Buffer) {
          if (name === "slow.txt") {
            gate.pending = true;
            try {
              await gate.wait;
              return await store.writeText(name, content);
            } finally {
              gate.pending = false;
              gate.finish();
            }
          }
          try {
            return await store.writeText(name, content);
          } catch (error) {
            gate.failObserved();
            throw error;
          }
        },
      };
    },
  };
});

afterEach(() => vi.restoreAllMocks());

it("settles all attachment writers before cleanup after a real store-key rejection", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lane3-attachment-race-"));
  let release = () => {};
  let observedFailure = () => {};
  gate.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.finished = new Promise<void>((resolve) => {
    gate.finish = resolve;
  });
  const failure = new Promise<void>((resolve) => {
    observedFailure = resolve;
  });
  gate.failObserved = observedFailure;
  let cleanupWhileWriterPending = false;
  let cleanupComplete = () => {};
  const cleanupCompleted = new Promise<void>((resolve) => {
    cleanupComplete = resolve;
  });
  const realRm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (String(target).includes(path.join(workspace, ".openclaw", "attachments"))) {
      cleanupWhileWriterPending ||= gate.pending;
    }
    const result = await realRm(target, options);
    cleanupComplete();
    return result;
  });
  const result = materializeSubagentAttachments({
    config: { tools: { sessions_spawn: { attachments: { enabled: true } } } },
    targetAgentId: "main",
    workspaceDir: workspace,
    attachments: [
      { name: "bad.", content: "invalid canonical store name" },
      { name: "slow.txt", content: "retained private input" },
    ],
  });
  try {
    await failure;
    // A pending native write may resume on a later I/O turn. Drain all rejection
    // continuations before releasing that real write; no arbitrary elapsed delay.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (cleanupWhileWriterPending) {
      await cleanupCompleted;
    }
    release();
    await gate.finished;
    expect(await result).toMatchObject({ status: "error" });
    expect(await fs.readdir(path.join(workspace, ".openclaw", "attachments"))).toEqual([]);
    expect(cleanupWhileWriterPending).toBe(false);
  } finally {
    release();
    await gate.finished;
    await result;
    await realRm(workspace, { recursive: true, force: true });
  }
});
