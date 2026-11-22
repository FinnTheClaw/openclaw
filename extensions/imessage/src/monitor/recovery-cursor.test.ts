import { createHash } from "node:crypto";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import {
  createIMessagePluginStateSyncStoreForTest,
  installIMessageStateRuntimeForTest,
} from "../test-support/runtime.js";
import { advanceIMessageRecoveryCursor, loadIMessageRecoveryCursor } from "./recovery-cursor.js";

const accountId = "default";
const dbIdentity = "remote:synthetic:chat.db";
const cursorKey = createHash("sha256")
  .update(JSON.stringify([accountId, dbIdentity]), "utf8")
  .digest("hex")
  .slice(0, 32);
const cursorStoreOptions = { namespace: "imessage.recovery-cursor", maxEntries: 64 };

function seedCursor(rowid: number) {
  createIMessagePluginStateSyncStoreForTest<{ lastRowid: number }>(cursorStoreOptions).register(
    cursorKey,
    { lastRowid: rowid },
  );
}

function interceptCursorStore(options: { writeError?: Error } = {}) {
  const state = getIMessageRuntime().state;
  const openKeyedStore = state.openKeyedStoreV2.bind(state);
  const syncOpen = vi.spyOn(state, "openSyncKeyedStore");
  vi.spyOn(state, "openKeyedStoreV2").mockImplementation(
    <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store = openKeyedStore<T>(storeOptions);
      const writeError = options.writeError;
      if (writeError) {
        store.compareAndApply = async () => {
          throw writeError;
        };
      }
      return store;
    },
  );
  return syncOpen;
}

describe("iMessage recovery cursor persistence", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the greatest row across concurrent completions", async () => {
    const syncOpen = interceptCursorStore();
    await Promise.all(
      [30, 10, 50, 20, 40].map((rowid) =>
        advanceIMessageRecoveryCursor(accountId, dbIdentity, rowid),
      ),
    );
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(50);
    expect(await loadIMessageRecoveryCursor("other", dbIdentity)).toBeNull();
    expect(await loadIMessageRecoveryCursor(accountId, "remote:synthetic:other.db")).toBeNull();
    expect(syncOpen).not.toHaveBeenCalled();
  });

  it("persists an expected-row rewind for a replaced database", async () => {
    seedCursor(9000);
    const syncOpen = interceptCursorStore();
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity, { watermarkRowid: 5000 })).toBe(
      5000,
    );
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(5000);
    expect(syncOpen).not.toHaveBeenCalled();
  });

  it.each(["advance", "rewind"] as const)(
    "keeps the persisted cursor after a failed %s write",
    async (operation) => {
      seedCursor(9000);
      const syncOpen = interceptCursorStore({ writeError: new Error("storage unavailable") });
      if (operation === "advance") {
        await advanceIMessageRecoveryCursor(accountId, dbIdentity, 9100);
      } else {
        expect(
          await loadIMessageRecoveryCursor(accountId, dbIdentity, { watermarkRowid: 5000 }),
        ).toBe(5000);
      }
      expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(9000);
      expect(syncOpen).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "retains a database-scoped cursor after migration write failure (newer winner: %s)",
    async (newerWins) => {
      const legacyKey = `${accountId}\u0000${dbIdentity}`;
      const rows = new Map([[legacyKey, { lastRowid: 31 }]]);
      const failure = new Error("storage unavailable before cursor adoption");
      const registerIfAbsent = vi
        .fn(async (key: string, value: { lastRowid: number }) => {
          if (newerWins) {
            rows.set(key, { lastRowid: 50 });
            return false;
          }
          rows.set(key, value);
          return true;
        })
        .mockRejectedValueOnce(failure);
      const state = getIMessageRuntime().state;
      vi.spyOn(state, "openKeyedStoreV2").mockReturnValue({
        lookup: async (key: string) => rows.get(key),
        entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
        consume: async (key: string) => {
          const value = rows.get(key);
          rows.delete(key);
          return value;
        },
        registerIfAbsent,
      } as unknown as ReturnType<typeof state.openKeyedStoreV2>);

      await expect(loadIMessageRecoveryCursor(accountId, dbIdentity)).rejects.toBe(failure);
      expect(rows.get(legacyKey)).toEqual({ lastRowid: 31 });
      expect(rows.has(cursorKey)).toBe(false);

      const expected = newerWins ? 50 : 31;
      await expect(loadIMessageRecoveryCursor(accountId, dbIdentity)).resolves.toBe(expected);
      expect(rows.get(cursorKey)).toEqual({ lastRowid: expected });
      expect(rows.has(legacyKey)).toBe(false);
      expect(registerIfAbsent).toHaveBeenCalledTimes(2);
    },
  );
});
