import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { materializeSubagentAttachments } from "./subagent-attachments.js";

const gate = vi.hoisted(() => ({
  wait: Promise.resolve(),
  entered: () => {},
  pending: false,
  writes: [] as string[],
  cleanupWhileWriterPending: false,
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
          gate.writes.push(path.basename(name));
          if (path.basename(name) === "slow.txt") {
            gate.pending = true;
            gate.entered();
            try {
              await gate.wait;
              return await store.writeText(name, content);
            } finally {
              gate.pending = false;
            }
          }
          return await store.writeText(name, content);
        },
      };
    },
  };
});

vi.mock("../../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/fs-safe.js")>();
  return {
    ...actual,
    async root(rootDir: string) {
      const ownedRoot = await actual.root(rootDir);
      return {
        ...ownedRoot,
        async remove(...args: Parameters<typeof ownedRoot.remove>) {
          gate.cleanupWhileWriterPending ||= gate.pending;
          return await ownedRoot.remove(...args);
        },
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "lane3-attachment-race-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  gate.writes = [];
  gate.pending = false;
  gate.cleanupWhileWriterPending = false;
  gate.wait = Promise.resolve();
  gate.entered = () => {};
  const childSessionKey = "agent:main:subagent:cleanup-race";
  return {
    state,
    childSessionKey,
    root: resolveSubagentSessionAttachmentRootDir({ agentId: "main", childSessionKey }),
    config: { tools: { sessions_spawn: { attachments: { enabled: true } } } },
  };
}

// Upstream now stages serially in a Gateway-owned per-session root. Preserve
// the prior no-cleanup-during-write invariant without resurrecting parallel IO
// or treating the retired workspace-relative staging path as authoritative.
it("does not start a sibling writer after a real store-key rejection", async () => {
  const f = await fixture();
  try {
    const result = await materializeSubagentAttachments({
      config: f.config,
      targetAgentId: "main",
      childSessionKey: f.childSessionKey,
      attachments: [
        { name: "bad.", content: "invalid canonical store name" },
        { name: "slow.txt", content: "must not start after rejection" },
      ],
    });
    expect(result).toMatchObject({ status: "error" });
    expect(gate.writes).toEqual(["bad."]);
    expect(gate.pending).toBe(false);
    expect(gate.cleanupWhileWriterPending).toBe(false);
    // The invalid native key is rejected before any staging directory exists.
    await expect(fs.stat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(f.state, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "settles an in-flight native writer before cancellation cleanup (active=%s)",
  async (remainsActive) => {
    const f = await fixture();
    let release = () => {};
    let active = true;
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve;
    });
    const result = materializeSubagentAttachments({
      config: f.config,
      targetAgentId: "main",
      childSessionKey: f.childSessionKey,
      assertActive: () => {
        if (!active) {
          throw new Error("owned staging cancelled");
        }
      },
      attachments: [
        { name: "slow.txt", content: "retained private input" },
        { name: "next.txt", content: "only while active" },
      ],
    });
    try {
      await entered;
      expect(gate.pending).toBe(true);
      active = remainsActive;
      release();
      const outcome = await result;
      expect(gate.pending).toBe(false);
      expect(gate.cleanupWhileWriterPending).toBe(false);
      if (remainsActive) {
        expect(outcome).toMatchObject({ status: "ok", receipt: { count: 2 } });
        expect(gate.writes).toEqual(["slow.txt", "next.txt"]);
        if (outcome.status !== "ok") {
          throw new Error("Expected native attachment receipt");
        }
        expect(await fs.readFile(path.join(f.root, outcome.attachmentId, "slow.txt"), "utf8")).toBe(
          "retained private input",
        );
        expect(await fs.readFile(path.join(f.root, outcome.attachmentId, "next.txt"), "utf8")).toBe(
          "only while active",
        );
      } else {
        expect(outcome).toMatchObject({ status: "error", error: "owned staging cancelled" });
        expect(gate.writes).toEqual(["slow.txt"]);
        expect(await fs.readdir(f.root)).toEqual([]);
      }
    } finally {
      release();
      await result;
      await fs.rm(f.state, { recursive: true, force: true });
    }
  },
);
