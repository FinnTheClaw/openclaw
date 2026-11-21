import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getMatrixRuntime, setMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  openMatrixIdbSnapshotStoreOptions,
  readMatrixIdbSnapshotJson,
  writeMatrixIdbSnapshotJson,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  requestResult,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";
import { LogService } from "./logger.js";

const DATABASE_PREFIX = "openclaw-matrix-persistence-test";
const OTHER_DATABASE_PREFIX = "openclaw-matrix-persistence-other-test";
const cryptoDatabaseName = `${DATABASE_PREFIX}::matrix-sdk-crypto`;
const otherCryptoDatabaseName = `${OTHER_DATABASE_PREFIX}::matrix-sdk-crypto`;

function writeTestSnapshot(snapshotPath: string, snapshots: unknown[]): Promise<void> {
  return writeMatrixIdbSnapshotJson({
    storageRootDir: path.dirname(snapshotPath),
    snapshotJson: JSON.stringify(snapshots),
    databaseCount: snapshots.length,
  });
}

function uniqueEmailStore(
  records: Array<{ key: IDBValidKey; value: { email: string } }>,
  name = "sessions",
) {
  return {
    name,
    keyPath: null,
    autoIncrement: false,
    indexes: [{ name: "email", keyPath: "email", multiEntry: false, unique: true }],
    records,
  };
}

async function clearTestIndexedDbState(): Promise<void> {
  await clearAllIndexedDbState({ databasePrefix: DATABASE_PREFIX });
  await clearAllIndexedDbState({ databasePrefix: OTHER_DATABASE_PREFIX });
}

describe("Matrix IndexedDB persistence", () => {
  let tmpDir: string;
  let snapshotPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const records = (key: string, session: string) => [{ key, value: { session } }];
  const seed = (rows = records("room-1", "abc123"), name = cryptoDatabaseName, version?: number) =>
    seedDatabase({ name, version, storeName: "sessions", records: rows });
  const read = (name = cryptoDatabaseName, version?: number) =>
    readDatabaseRecords({ name, version, storeName: "sessions" });
  const persist = (strict?: boolean) =>
    persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict });
  const restore = () => restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX);
  const write = (snapshotJson: string, databaseCount = 1) =>
    writeMatrixIdbSnapshotJson({ storageRootDir: tmpDir, snapshotJson, databaseCount });
  const openStore = <T>() =>
    createPluginStateKeyedStoreForTests<T>("matrix", openMatrixIdbSnapshotStoreOptions(tmpDir));
  const invalidSnapshots = ["[]", "{}", "null", "", "{"];

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearTestIndexedDbState();
    await closeOpenClawStateDatabaseAsync();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores database contents for the selected prefix", async () => {
    expect(await restore()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    const originalRuntime = getMatrixRuntime();
    const stateRuntime = { openKeyedStoreV2: originalRuntime.state.openKeyedStoreV2 };
    await seed();
    await seed(records("room-2", "should-not-restore"), otherCryptoDatabaseName);

    setMatrixRuntime({
      ...originalRuntime,
      state: {
        ...originalRuntime.state,
        openKeyedStoreV2: () => {
          throw new Error("ambient Matrix runtime is unavailable");
        },
      },
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: DATABASE_PREFIX,
      stateRuntime,
    });
    expect(fs.existsSync(snapshotPath)).toBe(false);

    await clearAllIndexedDbState({ databasePrefix: DATABASE_PREFIX });
    await seed(records("stale", "old-owner"));

    expect(await restoreIdbFromDisk(snapshotPath, stateRuntime, DATABASE_PREFIX)).toBe(true);
    expect(await read()).toEqual(records("room-1", "abc123"));
    expect(await read(otherCryptoDatabaseName)).toEqual(records("room-2", "should-not-restore"));
  });

  it.each([
    ...invalidSnapshots,
    "metadata",
    "null metadata",
    "missing metadata",
    "missing chunk",
    "malformed chunk",
    "digest",
  ] as const)(
    "refuses invalid snapshot %j without deleting keys or replacing stored state",
    async (corruption) => {
      const retained = records("room-1", "retained-key");
      await seed(retained);
      const store = openStore<Record<string, unknown> | null>();
      const invalidJson = invalidSnapshots.includes(corruption);
      if (invalidJson) {
        await write(corruption);
      } else {
        await persist(true);
        const meta = await store.lookup("current:meta");
        if (!meta || typeof meta.generation !== "string") {
          throw new Error("expected published snapshot metadata");
        }
        const chunkKey = `current:snapshot:${meta.generation}:0`;
        if (corruption === "missing metadata") {
          await store.delete("current:meta");
        } else if (corruption === "null metadata") {
          await store.register("current:meta", null);
        } else if (corruption === "missing chunk") {
          await store.delete(chunkKey);
        } else if (corruption === "malformed chunk") {
          await store.register(chunkKey, { ...(await store.lookup(chunkKey)), index: -1 });
        } else {
          await store.register(
            "current:meta",
            corruption === "metadata" ? { ...meta, version: 0 } : { ...meta, digest: "incorrect" },
          );
        }
      }
      const storedRows = await store.entries();

      await expect(restore()).rejects.toThrow();
      expect(await read()).toEqual(retained);
      await expect(persist(true)).rejects.toThrow();
      expect(await store.entries()).toEqual(storedRows);
      if (invalidJson) {
        expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(corruption);
      }
    },
  );

  it.each([
    { failure: "invalid record key", errorName: "DataError", invalidKey: true, later: false },
    {
      failure: "unique index conflict",
      errorName: "ConstraintError",
      invalidKey: false,
      later: false,
    },
    { failure: "invalid later database", errorName: "DataError", invalidKey: true, later: true },
  ])(
    "preserves retained account keys after $failure during replay",
    async ({ errorName, invalidKey, later }) => {
      const retained = records("retained", "retained-key");
      const unrelated = records("other-room", "other-account-key");
      await seed(retained, cryptoDatabaseName, 3);
      await seed(unrelated, otherCryptoDatabaseName);
      const databasesBefore = await indexedDB.databases();
      const invalidStore = {
        name: "sessions",
        keyPath: null,
        autoIncrement: false,
        indexes: [{ name: "session", keyPath: "session", multiEntry: false, unique: true }],
        records: [
          { key: "room-1", value: { session: "duplicate" } },
          { key: invalidKey ? null : "room-2", value: { session: "duplicate" } },
        ],
      };
      const snapshot = [{ name: cryptoDatabaseName, version: 1, stores: [invalidStore] }];
      if (later) {
        snapshot[0]!.stores = [{ ...invalidStore, records: [invalidStore.records[0]!] }];
        snapshot.push({ name: `${DATABASE_PREFIX}::later`, version: 1, stores: [invalidStore] });
      }
      const snapshotJson = JSON.stringify(snapshot);
      await write(snapshotJson, snapshot.length);
      await expect(restore()).rejects.toMatchObject({ name: errorName });
      expect(await indexedDB.databases()).toEqual(databasesBefore);
      expect(await read(cryptoDatabaseName, 3)).toEqual(retained);
      expect(await read(otherCryptoDatabaseName)).toEqual(unrelated);
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
      expect(warnSpy).toHaveBeenCalledWith(
        "IdbPersistence",
        "Failed to restore IndexedDB snapshot from SQLite:",
        expect.objectContaining({ name: errorName }),
      );
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(cryptoDatabaseName);
        void requestResult(request).then(() => resolve(), reject);
        request.addEventListener(
          "blocked",
          () => reject(new Error("Failed restore left its IndexedDB connection open")),
          { once: true },
        );
      });
    },
  );

  it.each(["duplicate", "foreign account"])(
    "refuses %s snapshot database names without changing retained keys",
    async (invalidName) => {
      const retained = records("retained", "retained-key");
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        await seed(retained, name);
      }
      const snapshotJson = JSON.stringify([
        { name: cryptoDatabaseName, version: 1, stores: [] },
        {
          name: invalidName === "duplicate" ? cryptoDatabaseName : otherCryptoDatabaseName,
          version: 1,
          stores: [],
        },
      ]);
      await write(snapshotJson, 2);
      await expect(restore()).rejects.toThrow("Malformed IndexedDB snapshot database names");
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        expect(await read(name)).toEqual(retained);
      }
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    },
  );

  it("reassembles exact snapshot bytes beyond chunk 9", async () => {
    const snapshotJson = JSON.stringify({
      records: Array.from({ length: 24 }, (_, index) => `${index}:🦞${"x".repeat(15_000)}`),
    });
    await write(snapshotJson);
    const store = openStore<Record<string, unknown>>();
    const stateRuntime: MatrixSnapshotStateRuntime = {
      openKeyedStoreV2<T>(options: OpenAsyncKeyedStoreOptions) {
        return createPluginStateKeyedStoreForTests<T>("matrix", options);
      },
    };
    expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).resolves.toBe(snapshotJson);
    const laterChunk = (await store.entries()).find(
      (row) => row.value.kind === "snapshot-chunk" && row.value.index === 11,
    );
    if (!laterChunk) {
      throw new Error("expected snapshot chunk 11");
    }
    await closeOpenClawStateDatabaseAsync();
    const source = openOpenClawStateDatabase({
      env: openMatrixIdbSnapshotStoreOptions(tmpDir).env,
    });
    if (!(source.db instanceof DatabaseSync)) {
      throw new Error("Matrix snapshot corruption fixture requires SQLite");
    }
    const corruptRoot = path.join(tmpDir, "corrupt-startup");
    fs.mkdirSync(path.join(corruptRoot, "state"), { recursive: true });
    await backup(source.db, path.join(corruptRoot, "state", "openclaw.sqlite"));
    await closeOpenClawStateDatabaseAsync();
    // Seed corruption before the new database has any cached keyed-store receipts.
    const corrupt = openOpenClawStateDatabase({
      env: openMatrixIdbSnapshotStoreOptions(corruptRoot).env,
    });
    expect(
      corrupt.db
        .prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?")
        .run("invalid JSON", laterChunk.key).changes,
    ).toBe(1);
    await closeOpenClawStateDatabaseAsync();
    await expect(readMatrixIdbSnapshotJson(corruptRoot)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
    await expect(readMatrixIdbSnapshotJson(corruptRoot, stateRuntime)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it("refuses retired snapshot JSON when canonical SQLite state is valid", async () => {
    const snapshot = JSON.stringify([{ name: cryptoDatabaseName, version: 1, stores: [] }]);
    const canonicalSnapshot = JSON.stringify([
      { name: otherCryptoDatabaseName, version: 1, stores: [] },
    ]);
    await write(canonicalSnapshot);
    fs.writeFileSync(snapshotPath, snapshot);
    const remediation =
      'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest.';

    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
      name: "MatrixIdbSnapshotMigrationRequiredError",
      code: "matrix-idb-snapshot-requires-doctor",
      remediation,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "IdbPersistence",
      expect.objectContaining({
        code: "matrix-idb-snapshot-requires-doctor",
        remediation,
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(snapshotPath);
    const databaseNames = (await indexedDB.databases()).map((database) => database.name);
    expect(databaseNames).not.toContain(cryptoDatabaseName);
    expect(databaseNames).not.toContain(otherCryptoDatabaseName);

    await seed(records("new-room", "new"));
    await expect(persist()).rejects.toMatchObject({
      code: "matrix-idb-snapshot-requires-doctor",
      remediation,
    });
    expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(canonicalSnapshot);
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(snapshot);

    vi.spyOn(getMatrixRuntime().state, "openKeyedStoreV2").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });
    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-requires-doctor",
      remediation,
    });
  });

  it("skips unchanged idle writes while retaining changed snapshots and orphan cleanup", async () => {
    await seed();
    await Promise.all([persist(), persist()]);
    await waitForDiagnosticEventsDrained();
    let writers = 0;
    onTestFinished(
      onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.kind === "sqlite_writer" &&
            event.phase === "queued"
          ) {
            writers++;
          }
        },
        { include: ["worker.request"] },
      ),
    );
    for (let minute = 0; minute < 5; minute++) {
      await persist(true);
    }
    await waitForDiagnosticEventsDrained();
    expect(writers).toBe(0);
    const store = openStore<Record<string, unknown>>();
    const before = await store.entries();
    await store.register("current:snapshot:interrupted:0", {
      kind: "snapshot-chunk",
      index: 0,
      data: "orphan",
    });
    await persist(true);
    expect(await store.entries()).toEqual(before);
    await seed(records("room-1", "changed"));
    await persist(true);

    await clearTestIndexedDbState();
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(read()).resolves.toEqual(records("room-1", "changed"));
  });

  it("strictly propagates final IndexedDB persistence failures", async () => {
    const cause = new Error("indexeddb unavailable");
    vi.spyOn(indexedDB, "databases").mockRejectedValue(cause);
    await expect(persist(true)).rejects.toBe(cause);
  });

  it("cancels an active snapshot before writing without warning", async () => {
    await seed();
    const databaseList = await indexedDB.databases();
    const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
    const databasesSpy = vi.spyOn(indexedDB, "databases").mockReturnValue(pendingDatabases.promise);
    const abortController = new AbortController();

    try {
      const persistence = persistIdbToDisk({
        snapshotPath,
        databasePrefix: DATABASE_PREFIX,
        abortSignal: abortController.signal,
      });
      await vi.waitFor(() => {
        expect(databasesSpy).toHaveBeenCalledTimes(1);
      });

      abortController.abort();
      pendingDatabases.resolve(databaseList);

      await expect(persistence).resolves.toBeUndefined();
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      pendingDatabases.resolve(databaseList);
      databasesSpy.mockRestore();
    }
  });
});

describe("Matrix IndexedDB restore transaction outcomes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-abort-"));
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    await clearTestIndexedDbState();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("IDB-A01 settles false on a duplicate unique-index value", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([
            { key: "one", value: { email: "same@example.org" } },
            { key: "two", value: { email: "same@example.org" } },
          ]),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
  });

  it("IDB-A02 settles false on a multi-entry unique-index collision", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          {
            name: "sessions",
            keyPath: null,
            autoIncrement: false,
            indexes: [{ name: "tags", keyPath: "tags", multiEntry: true, unique: true }],
            records: [
              { key: "one", value: { tags: ["a", "shared"] } },
              { key: "two", value: { tags: ["b", "shared"] } },
            ],
          },
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
  });

  it("IDB-A03 preserves an existing record when a later restore conflicts", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore([{ key: "old", value: { email: "same@example.org" } }])],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore([{ key: "new", value: { email: "same@example.org" } }])],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual([{ key: "old", value: { email: "same@example.org" } }]);
  });

  it("IDB-A04 closes the database after a synchronous invalid-key failure", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([
            { key: { invalid: true } as unknown as IDBValidKey, value: { email: "a@example.org" } },
          ]),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
    await expect(
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(cryptoDatabaseName);
        request.addEventListener("success", () => resolve(), { once: true });
        request.addEventListener("blocked", () => reject(new Error("database remained open")), {
          once: true,
        });
        request.addEventListener("error", () => reject(request.error), { once: true });
      }),
    ).resolves.toBeUndefined();
  });

  it("IDB-A05 settles false when a later store aborts after the first commits", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([{ key: "ok", value: { email: "ok@example.org" } }], "first"),
          uniqueEmailStore(
            [
              { key: "one", value: { email: "same@example.org" } },
              { key: "two", value: { email: "same@example.org" } },
            ],
            "second",
          ),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "first" }),
    ).resolves.toEqual([{ key: "ok", value: { email: "ok@example.org" } }]);
  });

  it("IDB-A06 releases the lock for a corrected retry at the same path", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([
            { key: "one", value: { email: "same@example.org" } },
            { key: "two", value: { email: "same@example.org" } },
          ]),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([
            { key: "one", value: { email: "one@example.org" } },
            { key: "two", value: { email: "two@example.org" } },
          ]),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toHaveLength(2);
  });

  it("IDB-A07 permits persistence after an aborted restore", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [
          uniqueEmailStore([
            { key: "one", value: { email: "same@example.org" } },
            { key: "two", value: { email: "same@example.org" } },
          ]),
        ],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(false);
    await expect(
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict: true }),
    ).resolves.toBeUndefined();
  });

  it("IDB-A08 restores an empty store without waiting for a transaction", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore([])],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual([]);
  });

  it("IDB-A09 preserves distinct indexed records on success", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const records = [
      { key: "one", value: { email: "one@example.org" } },
      { key: "two", value: { email: "two@example.org" } },
    ];
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore(records)],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual(records);
  });

  it("IDB-A10 restores both databases in a valid multi-database snapshot", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeTestSnapshot(snapshotPath, [
      {
        name: cryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore([{ key: "one", value: { email: "one@example.org" } }])],
      },
      {
        name: otherCryptoDatabaseName,
        version: 1,
        stores: [uniqueEmailStore([{ key: "two", value: { email: "two@example.org" } }])],
      },
    ]);
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual([{ key: "one", value: { email: "one@example.org" } }]);
    await expect(
      readDatabaseRecords({ name: otherCryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual([{ key: "two", value: { email: "two@example.org" } }]);
  });
});
