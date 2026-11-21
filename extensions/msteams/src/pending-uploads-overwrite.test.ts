import { createHash } from "node:crypto";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPendingUploadFs, storePendingUploadFs } from "./pending-uploads-fs.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";
import { useMSTeamsStateTempDirs } from "./test-support/state.js";

const tempDirs = useMSTeamsStateTempDirs();
const chunkBytes = 36 * 1024;

async function put(id: string, bytes: Buffer, filename = "file.bin"): Promise<void> {
  await storePendingUploadFs({ id, buffer: bytes, filename, conversationId: "19:test@thread.v2" });
}

async function expectExact(id: string, bytes: Buffer, filename: string): Promise<void> {
  const result = await getPendingUploadFs(id);
  expect(result?.buffer.equals(bytes)).toBe(true);
  expect(result?.filename).toBe(filename);
}

function mockStore(
  namespace: string,
  hooks: {
    maxEntries?: number;
    beforeRegister?: () => void;
    afterRegister?: () => Promise<void>;
    beforeDelete?: () => void;
  },
): void {
  const open = msteamsRuntimeStub.state.openKeyedStoreV2;
  vi.spyOn(msteamsRuntimeStub.state, "openKeyedStoreV2").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions, authority?: PluginStateActionAuthority) => {
      if (options.namespace !== namespace) {
        return open<T>(options, authority);
      }
      const store = open<T>(
        hooks.maxEntries !== undefined && options.retention !== "retained"
          ? { ...options, maxEntries: hooks.maxEntries }
          : options,
        authority,
      );
      const register = store.register.bind(store);
      const deleteRow = store.delete.bind(store);
      store.register = async (...args) => {
        hooks.beforeRegister?.();
        await register(...args);
        await hooks.afterRegister?.();
      };
      store.delete = async (...args) => {
        hooks.beforeDelete?.();
        return await deleteRow(...args);
      };
      return store;
    },
  );
}

function injectRegisterFailure(namespace: string, failAt: number): void {
  let writes = 0;
  mockStore(namespace, {
    beforeRegister() {
      writes += 1;
      if (writes === failAt) {
        throw new Error("injected SQLite register failure");
      }
    },
  });
}

describe("MSTeams pending upload overwrite with real SQLite", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("msteams-overwrite-"));
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("MU01 single-chunk success publishes exact replacement and metadata", async () => {
    await put("mu01", Buffer.from("old"), "old.txt");
    await put("mu01", Buffer.from("new"), "new.txt");
    await expectExact("mu01", Buffer.from("new"), "new.txt");
  });

  it("MU02 failed first replacement chunk preserves old upload", async () => {
    await put("mu02", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 1);
    await expect(put("mu02", Buffer.from("new"), "new.txt")).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact("mu02", Buffer.from("old"), "old.txt");
  });

  it("MU03 failed middle replacement chunk preserves old upload", async () => {
    await put("mu03", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 2);
    await expect(put("mu03", Buffer.alloc(chunkBytes * 2 + 5, 7))).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact("mu03", Buffer.from("old"), "old.txt");
  });

  it("MU04 failed metadata publication preserves old upload", async () => {
    await put("mu04", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-uploads", 1);
    await expect(put("mu04", Buffer.alloc(chunkBytes + 3, 2))).rejects.toThrow(
      "injected SQLite register failure",
    );
    await expectExact("mu04", Buffer.from("old"), "old.txt");
  });

  it("MU05 larger replacement publishes all chunks without old bytes", async () => {
    const next = Buffer.alloc(chunkBytes * 2 + 9, 8);
    await put("mu05", Buffer.from("old"), "old.txt");
    await put("mu05", next, "large.bin");
    await expectExact("mu05", next, "large.bin");
  });

  it("MU06 smaller replacement excludes old trailing chunks", async () => {
    await put("mu06", Buffer.alloc(chunkBytes * 2 + 9, 8), "large.bin");
    await put("mu06", Buffer.from("small"), "small.txt");
    await expectExact("mu06", Buffer.from("small"), "small.txt");
  });

  it("MU07 actual SQLite chunk-store capacity rejection preserves old upload", async () => {
    mockStore("pending-upload-chunks", { maxEntries: 1 });
    await put("mu07", Buffer.from("old"), "old.txt");
    await expect(put("mu07", Buffer.from("new"))).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expectExact("mu07", Buffer.from("old"), "old.txt");
  });

  it("MU08 reads, overwrites, and removes a legacy unversioned row", async () => {
    const id = "mu08";
    const prefix = "upload:" + createHash("sha256").update(id).digest("hex");
    const meta = createPluginStateKeyedStoreForTests<Record<string, unknown>>("msteams", {
      namespace: "pending-uploads",
      maxEntries: 200,
    });
    const chunks = createPluginStateKeyedStoreForTests<Record<string, unknown>>("msteams", {
      namespace: "pending-upload-chunks",
      maxEntries: 45_000,
      overflowPolicy: "reject-new",
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
    await expectExact(id, Buffer.from("legacy"), "legacy.txt");
    await put(id, Buffer.from("new"), "new.txt");
    await expectExact(id, Buffer.from("new"), "new.txt");
    expect(await chunks.lookup(prefix + ":chunk:0000")).toBeUndefined();
  });

  it("MU09 concurrent reader sees only a complete generation", async () => {
    const oldBytes = Buffer.from("old");
    const nextBytes = Buffer.alloc(chunkBytes + 5, 3);
    await put("mu09", oldBytes, "old.txt");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    mockStore("pending-upload-chunks", {
      async afterRegister() {
        if (!paused) {
          paused = true;
          entered();
          await gate;
        }
      },
    });
    const writer = put("mu09", nextBytes, "new.txt");
    await pending;
    const reader = getPendingUploadFs("mu09");
    release();
    await writer;
    const result = await reader;
    expect(result?.buffer.equals(oldBytes) || result?.buffer.equals(nextBytes)).toBe(true);
    await expectExact("mu09", nextBytes, "new.txt");
  });

  it("MU10 failed and successful replacements survive SQLite reopen", async () => {
    await put("mu10", Buffer.from("old"), "old.txt");
    injectRegisterFailure("pending-upload-chunks", 1);
    await expect(put("mu10", Buffer.from("failed"))).rejects.toThrow();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await expectExact("mu10", Buffer.from("old"), "old.txt");
    await put("mu10", Buffer.from("committed"), "new.txt");
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await expectExact("mu10", Buffer.from("committed"), "new.txt");
  });
  it("supplementary: failed old-chunk cleanup does not report a published replacement as failed", async () => {
    await put("cleanup", Buffer.from("old"), "old.txt");
    let failed = false;
    mockStore("pending-upload-chunks", {
      beforeDelete() {
        if (!failed) {
          failed = true;
          throw new Error("injected old-chunk cleanup failure");
        }
      },
    });
    await expect(put("cleanup", Buffer.from("new"), "new.txt")).resolves.toBeUndefined();
    expect(failed).toBe(true);
    await expectExact("cleanup", Buffer.from("new"), "new.txt");
  });
});
