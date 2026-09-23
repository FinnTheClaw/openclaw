import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPendingUploadFs, storePendingUploadFs } from "./pending-uploads-fs.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const dirs: string[] = [];
const chunkBytes = 36 * 1024;

async function envForCase(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "msteams-overwrite-"));
  dirs.push(dir);
  return { ...process.env, OPENCLAW_STATE_DIR: dir };
}

async function put(
  env: NodeJS.ProcessEnv,
  id: string,
  bytes: Buffer,
  filename = "file.bin",
): Promise<void> {
  await storePendingUploadFs(
    { id, buffer: bytes, filename, conversationId: "19:test@thread.v2" },
    { env },
  );
}

async function expectExact(
  env: NodeJS.ProcessEnv,
  id: string,
  bytes: Buffer,
  filename: string,
): Promise<void> {
  const result = await getPendingUploadFs(id, { env });
  expect(result?.buffer.equals(bytes)).toBe(true);
  expect(result?.filename).toBe(filename);
}

function injectRegisterFailure(namespace: string, failAt: number): void {
  const open = msteamsRuntimeStub.state.openKeyedStore.bind(msteamsRuntimeStub.state);
  let writes = 0;
  setMSTeamsRuntime({
    ...msteamsRuntimeStub,
    state: {
      ...msteamsRuntimeStub.state,
      openKeyedStore: ((options: OpenKeyedStoreOptions) => {
        const store = open(options);
        if (options.namespace !== namespace) {
          return store;
        }
        return {
          ...store,
          register: async (key: string, value: unknown, opts?: { ttlMs?: number }) => {
            writes += 1;
            if (writes === failAt) {
              throw new Error("injected SQLite register failure");
            }
            await store.register(key, value, opts);
          },
        };
      }) as typeof msteamsRuntimeStub.state.openKeyedStore,
    },
  });
}

describe("MSTeams pending upload overwrite with real SQLite", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  afterEach(async () => {
    setMSTeamsRuntime(msteamsRuntimeStub);
    setMaxPluginStateEntriesPerPluginForTests(undefined);
    resetPluginStateStoreForTests();
    while (dirs.length > 0) {
      await fs.promises.rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("MU01 single-chunk success publishes exact replacement and metadata", async () => {
    const env = await envForCase();
    await put(env, "mu01", Buffer.from("old"), "old.txt");
    await put(env, "mu01", Buffer.from("new"), "new.txt");
    await expectExact(env, "mu01", Buffer.from("new"), "new.txt");
  });

  it("MU02 failed first replacement chunk preserves old upload", async () => {
    const env = await envForCase();
    await put(env, "mu02", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 1);
    await expect(put(env, "mu02", Buffer.from("new"), "new.txt")).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact(env, "mu02", Buffer.from("old"), "old.txt");
  });

  it("MU03 failed middle replacement chunk preserves old upload", async () => {
    const env = await envForCase();
    await put(env, "mu03", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 2);
    await expect(put(env, "mu03", Buffer.alloc(chunkBytes * 2 + 5, 7))).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact(env, "mu03", Buffer.from("old"), "old.txt");
  });

  it("MU04 failed metadata publication preserves old upload", async () => {
    const env = await envForCase();
    await put(env, "mu04", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-uploads", 1);
    await expect(put(env, "mu04", Buffer.alloc(chunkBytes + 3, 2))).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact(env, "mu04", Buffer.from("old"), "old.txt");
  });

  it("MU05 larger replacement publishes all chunks without old bytes", async () => {
    const env = await envForCase();
    const next = Buffer.alloc(chunkBytes * 2 + 9, 8);
    await put(env, "mu05", Buffer.from("old"), "old.txt");
    await put(env, "mu05", next, "large.bin");
    await expectExact(env, "mu05", next, "large.bin");
  });

  it("MU06 smaller replacement excludes old trailing chunks", async () => {
    const env = await envForCase();
    await put(env, "mu06", Buffer.alloc(chunkBytes * 2 + 9, 8), "large.bin");
    await put(env, "mu06", Buffer.from("small"), "small.txt");
    await expectExact(env, "mu06", Buffer.from("small"), "small.txt");
  });

  it("MU07 actual SQLite plugin-row capacity rejection preserves old upload", async () => {
    const env = await envForCase();
    await put(env, "mu07", Buffer.from("old"), "old.txt");
    setMaxPluginStateEntriesPerPluginForTests(2);
    await expect(put(env, "mu07", Buffer.from("new"))).rejects.toThrow(/limit/i);
    await expectExact(env, "mu07", Buffer.from("old"), "old.txt");
  });

  it("MU08 reads, overwrites, and removes a legacy unversioned row", async () => {
    const env = await envForCase();
    const id = "mu08";
    const prefix = "upload:" + createHash("sha256").update(id).digest("hex");
    const meta = createPluginStateKeyedStoreForTests<Record<string, unknown>>("msteams", {
      namespace: "pending-uploads",
      maxEntries: 200,
      env,
    });
    const chunks = createPluginStateKeyedStoreForTests<Record<string, unknown>>("msteams", {
      namespace: "pending-upload-chunks",
      maxEntries: 45_000,
      overflowPolicy: "reject-new",
      env,
    });
    await chunks.register(prefix + ":chunk:0000", {
      id,
      index: 0,
      dataBase64: Buffer.from("legacy").toString("base64"),
    });
    await meta.register(prefix + ":meta", {
      id,
      filename: "legacy.txt",
      conversationId: "19:test@thread.v2",
      createdAt: Date.now(),
      chunkCount: 1,
      byteLength: 6,
    });
    await expectExact(env, id, Buffer.from("legacy"), "legacy.txt");
    await put(env, id, Buffer.from("new"), "new.txt");
    await expectExact(env, id, Buffer.from("new"), "new.txt");
    expect(await chunks.lookup(prefix + ":chunk:0000")).toBeUndefined();
  });

  it("MU09 concurrent reader sees only a complete generation", async () => {
    const env = await envForCase();
    const oldBytes = Buffer.from("old");
    const nextBytes = Buffer.alloc(chunkBytes + 5, 3);
    await put(env, "mu09", oldBytes, "old.txt");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const open = msteamsRuntimeStub.state.openKeyedStore.bind(msteamsRuntimeStub.state);
    let paused = false;
    setMSTeamsRuntime({
      ...msteamsRuntimeStub,
      state: {
        ...msteamsRuntimeStub.state,
        openKeyedStore: ((options: OpenKeyedStoreOptions) => {
          const store = open(options);
          if (options.namespace !== "pending-upload-chunks") {
            return store;
          }
          return {
            ...store,
            register: async (key: string, value: unknown, opts?: { ttlMs?: number }) => {
              await store.register(key, value, opts);
              if (!paused) {
                paused = true;
                entered();
                await gate;
              }
            },
          };
        }) as typeof msteamsRuntimeStub.state.openKeyedStore,
      },
    });
    const writer = put(env, "mu09", nextBytes, "new.txt");
    await pending;
    const reader = getPendingUploadFs("mu09", { env });
    release();
    await writer;
    const result = await reader;
    expect(result?.buffer.equals(oldBytes) || result?.buffer.equals(nextBytes)).toBe(true);
    await expectExact(env, "mu09", nextBytes, "new.txt");
  });

  it("MU10 failed and successful replacements survive SQLite reopen", async () => {
    const env = await envForCase();
    await put(env, "mu10", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 1);
    await expect(put(env, "mu10", Buffer.from("failed"))).rejects.toThrow();
    setMSTeamsRuntime(msteamsRuntimeStub);
    resetPluginStateStoreForTests();
    await expectExact(env, "mu10", Buffer.from("old"), "old.txt");
    await put(env, "mu10", Buffer.from("committed"), "new.txt");
    resetPluginStateStoreForTests();
    await expectExact(env, "mu10", Buffer.from("committed"), "new.txt");
  });
  it("supplementary: failed old-chunk cleanup does not report a published replacement as failed", async () => {
    const env = await envForCase();
    await put(env, "cleanup", Buffer.from("old"), "old.txt");
    const open = msteamsRuntimeStub.state.openKeyedStore.bind(msteamsRuntimeStub.state);
    let failed = false;
    setMSTeamsRuntime({
      ...msteamsRuntimeStub,
      state: {
        ...msteamsRuntimeStub.state,
        openKeyedStore: ((options: OpenKeyedStoreOptions) => {
          const store = open(options);
          if (options.namespace !== "pending-upload-chunks") {
            return store;
          }
          return {
            ...store,
            delete: async (key: string) => {
              if (!failed) {
                failed = true;
                throw new Error("injected old-chunk cleanup failure");
              }
              await store.delete(key);
            },
          };
        }) as typeof msteamsRuntimeStub.state.openKeyedStore,
      },
    });
    await expect(put(env, "cleanup", Buffer.from("new"), "new.txt")).resolves.toBeUndefined();
    expect(failed).toBe(true);
    await expectExact(env, "cleanup", Buffer.from("new"), "new.txt");
  });
});
