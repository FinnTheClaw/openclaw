import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  createMemoryWikiImportRunStateStore,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";

function record(created: string[], updated: string[] = []): ChatGptImportRunRecord {
  return {
    version: 1,
    runId: "run-1",
    importType: "chatgpt",
    exportPath: "/tmp/export",
    sourcePath: "/tmp/export/conversations.json",
    appliedAt: "2026-09-23T10:00:00.000Z",
    conversationCount: created.length + updated.length,
    createdCount: created.length,
    updatedCount: updated.length,
    skippedCount: 0,
    createdPaths: created.map((entry) => ({ path: entry })),
    updatedPaths: updated.map((entry) => ({ path: entry, snapshotPath: "snapshots/" + entry })),
  };
}

function harness() {
  const rows = new Map<string, unknown>();
  const control = { registerCount: 0, failRegisterAt: 0, failDelete: false };
  const fake = {
    async register(key: string, value: unknown) {
      control.registerCount += 1;
      if (control.registerCount === control.failRegisterAt) {
        throw new Error("interrupted path write");
      }
      rows.set(key, value);
    },
    async registerIfAbsent(key: string, value: unknown) {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, value);
      return true;
    },
    async lookup(key: string) {
      return rows.get(key);
    },
    async consume(key: string) {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    async delete(key: string) {
      if (control.failDelete) {
        throw new Error("stale cleanup failed");
      }
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      rows.clear();
    },
  };
  const store = createMemoryWikiImportRunStateStore(
    <T>(_options: OpenKeyedStoreOptions) => fake as unknown as PluginStateKeyedStore<T>,
  );
  return { store, control };
}

const vault = "/tmp/wiki-generation-test";

describe("memory-wiki committed import-run generation", () => {
  it.each([
    { name: "ST04-01 first write", first: null, next: record(["a.md"]) },
    { name: "ST04-02 equal rewrite", first: record(["a.md"]), next: record(["a.md"]) },
    { name: "ST04-03 shorter rewrite", first: record(["a.md", "b.md"]), next: record(["a.md"]) },
    { name: "ST04-04 longer rewrite", first: record(["a.md"]), next: record(["a.md", "b.md"]) },
    { name: "ST04-05 created to updated", first: record(["a.md"]), next: record([], ["a.md"]) },
    { name: "ST04-06 updated to created", first: record([], ["a.md"]), next: record(["a.md"]) },
  ])("$name", async ({ first, next }) => {
    const { store } = harness();
    if (first) {
      await store.write(vault, first);
    }
    await store.write(vault, next);
    await expect(store.read(vault, "run-1")).resolves.toEqual(next);
    await expect(store.list(vault)).resolves.toEqual([next]);
    await expect(store.rowCount()).resolves.toBe(
      1 + next.createdPaths.length + next.updatedPaths.length,
    );
  });

  it("ST04-07 ignores stale rows after post-commit deletion failure", async () => {
    const { store, control } = harness();
    await store.write(vault, record(["old.md"]));
    control.failDelete = true;
    await expect(store.write(vault, record(["new.md"]))).rejects.toThrow("stale cleanup failed");
    await expect(store.read(vault, "run-1")).resolves.toEqual(record(["new.md"]));
  });

  it("ST04-08 keeps old committed rows after a partial path write", async () => {
    const { store, control } = harness();
    await store.write(vault, record(["old.md"]));
    control.failRegisterAt = control.registerCount + 2;
    await expect(store.write(vault, record(["new.md", "later.md"]))).rejects.toThrow(
      "interrupted path write",
    );
    await expect(store.read(vault, "run-1")).resolves.toEqual(record(["old.md"]));
  });

  it("ST04-09 read and list agree despite stale rows", async () => {
    const { store, control } = harness();
    await store.write(vault, record(["old.md"]));
    control.failDelete = true;
    await expect(store.write(vault, record(["new.md"]))).rejects.toThrow("stale cleanup failed");
    const current = await store.read(vault, "run-1");
    await expect(store.list(vault)).resolves.toEqual([current]);
    expect(current?.createdPaths.map((entry) => entry.path)).toEqual(["new.md"]);
  });

  it("ST04-10 interrupted rewrite does not widen rollback targets", async () => {
    const { store, control } = harness();
    await store.write(vault, record(["original.md"]));
    control.failRegisterAt = control.registerCount + 2;
    await expect(store.write(vault, record(["unsaved.md", "unsaved-too.md"]))).rejects.toThrow();
    const targets = (await store.read(vault, "run-1"))?.createdPaths.map((entry) => entry.path);
    expect(targets).toEqual(["original.md"]);
    await expect(store.list(vault)).resolves.toEqual([record(["original.md"])]);
  });
});
