// Matrix tests cover storage plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  openMatrixLegacyCryptoMigrationStoreOptions,
  openMatrixRecoveryKeyStoreOptions,
} from "../crypto-state-store.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import {
  claimCurrentTokenStorageState,
  maybeMigrateLegacyStorage,
  openMatrixStorageMetaStoreOptions,
  recordCurrentStorageMetaDeviceId,
  repairCurrentTokenStorageMetaDeviceId,
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

describe("matrix client storage paths", () => {
  const tempDirs: string[] = [];
  const defaultStorageAuth = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "secret-token",
  };

  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTestLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
    logger = createTestLogger(),
  ): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    const stateDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(homeDir);
    installMatrixTestRuntime({
      cfg,
      logging: {
        getChildLogger: () => logger,
      },
      stateDir,
    });
    return stateDir;
  }

  function createMigrationEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      HOME: path.dirname(stateDir),
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
  }

  function resolveDefaultStoragePaths(
    overrides: Partial<{
      homeserver: string;
      userId: string;
      accessToken: string;
      accountId: string;
      deviceId: string;
    }> = {},
  ) {
    return resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      ...overrides,
      env: {},
    });
  }

  function setupCurrentTokenBackfillScenario(params: {
    currentRootFiles: "thread-bindings" | "startup-verification";
    oldRootFiles: "crypto-only" | "thread-bindings";
  }) {
    const stateDir = setupStateDir();
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(canonicalPaths.rootDir, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: canonicalPaths.tokenHash,
      deviceId: null,
    });
    if (params.currentRootFiles === "thread-bindings") {
      writeJson(canonicalPaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-new",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:new",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
      expect(
        claimCurrentTokenStorageState({
          rootDir: canonicalPaths.rootDir,
        }),
      ).toBe(true);
    } else {
      writeJson(canonicalPaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    if (params.oldRootFiles === "thread-bindings") {
      writeJson(oldStoragePaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-old",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:old",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
    } else {
      writeJson(oldStoragePaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    return { stateDir, canonicalPaths, oldStoragePaths };
  }

  it("resolves state file paths inside the selected storage root", () => {
    setupStateDir();
    const filePath = resolveMatrixStateFilePath({
      auth: {
        ...defaultStorageAuth,
        accountId: "ops",
        deviceId: "DEVICE1",
      },
      filename: "thread-bindings.json",
      env: {},
    });

    expect(filePath).toBe(
      path.join(
        resolveDefaultStoragePaths({ accountId: "ops", deviceId: "DEVICE1" }).rootDir,
        "thread-bindings.json",
      ),
    );
  });

  function legacySyncCacheBody(nextBatch = "legacy-token"): string {
    return JSON.stringify({
      version: 1,
      savedSync: {
        nextBatch,
        accountData: [],
        roomsData: {
          join: {},
          invite: {},
          leave: {},
          knock: {},
        },
      },
      cleanShutdown: true,
    });
  }

  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value, null, 2));
  }

  function readStorageMeta(rootDir: string): Record<string, unknown> | undefined {
    return createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    ).lookup("current");
  }

  function seedStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    ).register("current", value);
  }

  function seedLegacyStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    fs.mkdirSync(rootDir, { recursive: true });
    writeJson(rootDir, "storage-meta.json", value);
  }

  it("records a learned deviceId in SQLite storage metadata", () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      writeStorageMeta({
        storagePaths,
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        deviceId: null,
      }),
    ).toBe(true);

    expect(
      recordCurrentStorageMetaDeviceId({
        rootDir: storagePaths.rootDir,
        deviceId: "DEVICE123",
      }),
    ).toBe(true);

    expect(readStorageMeta(storagePaths.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
    expect(fs.existsSync(path.join(storagePaths.rootDir, "startup-verification.json"))).toBe(false);
  });

  function seedExistingStorageRoot(params: {
    accessToken: string;
    deviceId?: string;
    storageBody?: string;
    storageMeta?: Record<string, unknown>;
    startupVerificationDeviceId?: string;
  }) {
    const storagePaths = resolveDefaultStoragePaths({
      accessToken: params.accessToken,
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, params.storageBody ?? '{"legacy":true}');
    if (params.storageMeta) {
      seedStorageMeta(storagePaths.rootDir, params.storageMeta);
    }
    if (params.startupVerificationDeviceId) {
      writeJson(storagePaths.rootDir, "startup-verification.json", {
        deviceId: params.startupVerificationDeviceId,
      });
    }
    return storagePaths;
  }

  function seedCanonicalStorageRoot(params: {
    stateDir: string;
    accessToken: string;
    storageMeta: Record<string, unknown>;
  }) {
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir: params.stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: params.accessToken,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(canonicalPaths.rootDir, params.storageMeta);
    return canonicalPaths;
  }

  function expectCanonicalRootForNewDevice(stateDir: string) {
    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
        deviceId: "NEWDEVICE",
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "NEWDEVICE",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
  }

  it("uses the simplified matrix runtime root for account-scoped storage", () => {
    const stateDir = setupStateDir();

    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@Bot:example.org",
      accessToken: "secret-token",
      accountId: "ops",
      env: {},
    });

    expect(storagePaths.rootDir).toBe(
      path.join(
        stateDir,
        "matrix",
        "accounts",
        "ops",
        "matrix.example.org__bot_example.org",
        storagePaths.tokenHash,
      ),
    );
    expect(storagePaths.storagePath).toBe(path.join(storagePaths.rootDir, "bot-storage.json"));
    expect(storagePaths.cryptoPath).toBe(path.join(storagePaths.rootDir, "crypto"));
    expect(storagePaths.recoveryKeyPath).toBe(path.join(storagePaths.rootDir, "recovery-key.json"));
    expect(storagePaths.idbSnapshotPath).toBe(
      path.join(storagePaths.rootDir, "crypto-idb-snapshot.json"),
    );
  });

  it("migrates the previous account-scoped sync cache into sqlite before startup", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, legacySyncCacheBody("account-token"));
    const env = createMigrationEnv(stateDir);

    await maybeMigrateLegacyStorage({
      storagePaths,
      env,
    });

    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
    expect(fs.existsSync(`${storagePaths.storagePath}.migrated`)).toBe(true);
    const syncStore = new SqliteBackedMatrixSyncStore(storagePaths.rootDir);
    expect(syncStore.hasSavedSync()).toBe(true);
    await expect(syncStore.getSavedSyncToken()).resolves.toBe("account-token");
  });

  it("ignores unrecognized account-scoped sync cache files without a migration snapshot", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"new":true}');
    const env = createMigrationEnv(stateDir);

    await maybeMigrateLegacyStorage({
      storagePaths,
      env,
    });

    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"new":true}');
  });

  describe("legacy migration forward recovery", () => {
    const recoveryPayload = {
      version: 1,
      createdAt: "2026-09-23T00:00:00.000Z",
      privateKeyBase64: "cmVjb3Zlcnk=",
    };
    const cryptoPayload = {
      version: 1,
      accountId: "default",
      roomKeyCounts: null,
      restoreStatus: "pending",
    };
    type InputKind = "sync" | "recovery" | "crypto";

    function migrationFixture(inputs: InputKind[], logger = createTestLogger()) {
      const stateDir = setupStateDir(undefined, logger);
      const storagePaths = resolveDefaultStoragePaths();
      fs.mkdirSync(storagePaths.rootDir, { recursive: true });
      const sources = {
        sync: storagePaths.storagePath,
        recovery: storagePaths.recoveryKeyPath,
        crypto: path.join(storagePaths.rootDir, "legacy-crypto-migration.json"),
      };
      if (inputs.includes("sync")) {
        fs.writeFileSync(sources.sync, legacySyncCacheBody("retry-token"));
      }
      if (inputs.includes("recovery")) {
        fs.writeFileSync(sources.recovery, JSON.stringify(recoveryPayload));
      }
      if (inputs.includes("crypto")) {
        fs.writeFileSync(sources.crypto, JSON.stringify(cryptoPayload));
      }
      return { storagePaths, env: createMigrationEnv(stateDir), sources };
    }

    function readMigrationRow(
      rootDir: string,
      kind: "recovery" | "crypto",
    ): Record<string, unknown> | undefined {
      const options =
        kind === "recovery"
          ? openMatrixRecoveryKeyStoreOptions(rootDir)
          : openMatrixLegacyCryptoMigrationStoreOptions(rootDir);
      return (
        createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>("matrix", options).lookup(
          "current",
        ) ?? undefined
      );
    }

    function expectSource(source: string, state: "original" | "archived" | "both") {
      expect(fs.existsSync(source)).toBe(state === "original" || state === "both");
      expect(fs.existsSync(`${source}.migrated`)).toBe(state === "archived" || state === "both");
    }

    async function failMigration(
      fixture: ReturnType<typeof migrationFixture>,
      namespace: "sync-cache" | "recovery-key" | "legacy-crypto-migration",
    ) {
      const db = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: fixture.storagePaths.rootDir },
      }).db;
      const trigger = `fail_matrix_${namespace.replaceAll("-", "_")}`;
      db.exec(
        `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON plugin_state_entries
         WHEN NEW.plugin_id = 'matrix' AND NEW.namespace = '${namespace}'
         BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`,
      );
      try {
        await expect(maybeMigrateLegacyStorage(fixture)).rejects.toThrow(
          "Failed migrating legacy Matrix client storage",
        );
      } finally {
        db.exec(`DROP TRIGGER ${trigger}`);
      }
      expect(
        fs.existsSync(path.join(fixture.storagePaths.rootDir, "state", "openclaw.sqlite")),
      ).toBe(true);
    }

    it("late-crypto-write-preserves-all-inputs", async () => {
      const fixture = migrationFixture(["sync", "recovery", "crypto"]);
      await failMigration(fixture, "legacy-crypto-migration");
      for (const source of Object.values(fixture.sources)) {
        expectSource(source, "original");
      }
      const syncStore = new SqliteBackedMatrixSyncStore(fixture.storagePaths.rootDir);
      await expect(syncStore.getSavedSyncToken()).resolves.toBe("retry-token");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(
        recoveryPayload,
      );
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toBeUndefined();
    });

    it("late-crypto-write-retries-to-completion", async () => {
      const fixture = migrationFixture(["sync", "recovery", "crypto"]);
      await failMigration(fixture, "legacy-crypto-migration");
      const savedRecovery = readMigrationRow(fixture.storagePaths.rootDir, "recovery");
      await maybeMigrateLegacyStorage(fixture);
      for (const source of Object.values(fixture.sources)) {
        expectSource(source, "archived");
      }
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toEqual(savedRecovery);
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toMatchObject(cryptoPayload);
    });

    it("recovery-write-failure-preserves-sync-source", async () => {
      const fixture = migrationFixture(["sync", "recovery"]);
      await failMigration(fixture, "recovery-key");
      expectSource(fixture.sources.sync, "original");
      expectSource(fixture.sources.recovery, "original");
      await expect(
        new SqliteBackedMatrixSyncStore(fixture.storagePaths.rootDir).getSavedSyncToken(),
      ).resolves.toBe("retry-token");
      await maybeMigrateLegacyStorage(fixture);
      expectSource(fixture.sources.sync, "archived");
      expectSource(fixture.sources.recovery, "archived");
    });

    it("sync-write-failure-preserves-all-sources", async () => {
      const fixture = migrationFixture(["sync", "recovery", "crypto"]);
      await failMigration(fixture, "sync-cache");
      for (const source of Object.values(fixture.sources)) {
        expectSource(source, "original");
      }
      expect(new SqliteBackedMatrixSyncStore(fixture.storagePaths.rootDir).hasSavedSync()).toBe(
        false,
      );
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toBeUndefined();
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toBeUndefined();
      await maybeMigrateLegacyStorage(fixture);
      for (const source of Object.values(fixture.sources)) {
        expectSource(source, "archived");
      }
    });

    it("crypto-only-write-failure-preserves-source", async () => {
      const fixture = migrationFixture(["crypto"]);
      await failMigration(fixture, "legacy-crypto-migration");
      expectSource(fixture.sources.crypto, "original");
      await maybeMigrateLegacyStorage(fixture);
      expectSource(fixture.sources.crypto, "archived");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toMatchObject(cryptoPayload);
    });

    it("recovery-only-write-failure-preserves-source", async () => {
      const fixture = migrationFixture(["recovery"]);
      await failMigration(fixture, "recovery-key");
      expectSource(fixture.sources.recovery, "original");
      await maybeMigrateLegacyStorage(fixture);
      expectSource(fixture.sources.recovery, "archived");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(
        recoveryPayload,
      );
    });

    it("three-input-success-archives-after-commit", async () => {
      const fixture = migrationFixture(["sync", "recovery", "crypto"]);
      await maybeMigrateLegacyStorage(fixture);
      for (const source of Object.values(fixture.sources)) {
        expectSource(source, "archived");
      }
      await expect(
        new SqliteBackedMatrixSyncStore(fixture.storagePaths.rootDir).getSavedSyncToken(),
      ).resolves.toBe("retry-token");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(
        recoveryPayload,
      );
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toMatchObject(cryptoPayload);
    });

    it("preexisting-recovery-row-survives-late-failure", async () => {
      const fixture = migrationFixture(["recovery", "crypto"]);
      const existing = { ...recoveryPayload, privateKeyBase64: "cHJlZXhpc3Rpbmc=" };
      createPluginStateSyncKeyedStoreForTests(
        "matrix",
        openMatrixRecoveryKeyStoreOptions(fixture.storagePaths.rootDir),
      ).register("current", existing);
      await failMigration(fixture, "legacy-crypto-migration");
      expectSource(fixture.sources.recovery, "original");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(existing);
      await maybeMigrateLegacyStorage(fixture);
      expectSource(fixture.sources.recovery, "archived");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(existing);
    });

    it("existing-migrated-file-is-never-overwritten", async () => {
      const logger = createTestLogger();
      const fixture = migrationFixture(["recovery"], logger);
      const archived = `${fixture.sources.recovery}.migrated`;
      fs.writeFileSync(archived, "existing archive");
      const original = fs.readFileSync(fixture.sources.recovery);
      await maybeMigrateLegacyStorage(fixture);
      expectSource(fixture.sources.recovery, "both");
      expect(fs.readFileSync(fixture.sources.recovery)).toEqual(original);
      expect(fs.readFileSync(archived, "utf8")).toBe("existing archive");
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toMatchObject(
        recoveryPayload,
      );
      expect(logger.warn).toHaveBeenCalled();
    });

    it("completed-migration-repeat-is-idempotent", async () => {
      const fixture = migrationFixture(["sync", "recovery", "crypto"]);
      await maybeMigrateLegacyStorage(fixture);
      const before = Object.fromEntries(
        Object.entries(fixture.sources).map(([kind, source]) => [
          kind,
          fs.readFileSync(`${source}.migrated`),
        ]),
      );
      const recovery = readMigrationRow(fixture.storagePaths.rootDir, "recovery");
      const crypto = readMigrationRow(fixture.storagePaths.rootDir, "crypto");
      const files = fs.readdirSync(fixture.storagePaths.rootDir).toSorted();
      await maybeMigrateLegacyStorage(fixture);
      expect(fs.readdirSync(fixture.storagePaths.rootDir).toSorted()).toEqual(files);
      for (const [kind, source] of Object.entries(fixture.sources)) {
        expectSource(source, "archived");
        expect(fs.readFileSync(`${source}.migrated`)).toEqual(before[kind]);
      }
      expect(readMigrationRow(fixture.storagePaths.rootDir, "recovery")).toEqual(recovery);
      expect(readMigrationRow(fixture.storagePaths.rootDir, "crypto")).toEqual(crypto);
      await expect(
        new SqliteBackedMatrixSyncStore(fixture.storagePaths.rootDir).getSavedSyncToken(),
      ).resolves.toBe("retry-token");
    });
  });

  it("keeps the canonical current-token storage root when deviceId is still unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });

    expect(rotatedStoragePaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(rotatedStoragePaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("reuses an existing token-hash storage root for the same device after the access token changes", () => {
    const logger = createTestLogger();
    setupStateDir(undefined, logger);
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns with structured metadata when populated token-hash storage roots accumulate", () => {
    const logger = createTestLogger();
    const stateDir = setupStateDir(undefined, logger);
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });
    const canonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(path.join(canonicalPaths.rootDir, "crypto"), { recursive: true });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: multiple populated token-hash storage roots detected",
      {
        parentDir: path.dirname(canonicalPaths.rootDir),
        canonicalTokenHash: canonicalPaths.tokenHash,
        selectedTokenHash: canonicalPaths.tokenHash,
        populatedTokenHashes: [canonicalPaths.tokenHash, oldStoragePaths.tokenHash],
        populatedSiblingTokenHashes: [oldStoragePaths.tokenHash],
        populatedRootCount: 2,
      },
    );
  });

  it("does not scan token-history roots when the canonical current-token state is claimed", () => {
    const logger = createTestLogger();
    const stateDir = setupStateDir(undefined, logger);
    const oldCanonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-old",
    });
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: oldCanonicalPaths.tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });

    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });
    seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: canonicalPaths.tokenHash,
        deviceId: "DEVICE123",
        currentTokenStateClaimed: true,
      },
    });

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(readdirSync).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reads legacy storage metadata until doctor migrates it to SQLite", () => {
    setupStateDir();
    const oldStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
    });
    seedLegacyStorageMeta(oldStoragePaths.rootDir, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: oldStoragePaths.tokenHash,
      deviceId: "DEVICE123",
      currentTokenStateClaimed: true,
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(fs.existsSync(path.join(oldStoragePaths.rootDir, "state", "openclaw.sqlite"))).toBe(
      false,
    );
  });

  it.each(["thread-bindings.json", "recovery-key.json", "crypto-idb-snapshot.json"])(
    "keeps a legacy %s root selectable until its state migrates",
    (legacyFilename) => {
      const stateDir = setupStateDir();
      const oldStoragePaths = resolveDefaultStoragePaths({
        accessToken: "secret-token-old",
        deviceId: "DEVICE123",
      });
      seedLegacyStorageMeta(oldStoragePaths.rootDir, {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: oldStoragePaths.tokenHash,
        deviceId: "DEVICE123",
      });
      writeJson(oldStoragePaths.rootDir, legacyFilename, { legacy: true });

      seedCanonicalStorageRoot({
        stateDir,
        accessToken: "secret-token-new",
        storageMeta: {
          homeserver: defaultStorageAuth.homeserver,
          userId: defaultStorageAuth.userId,
          accountId: "default",
          accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" })
            .tokenHash,
          deviceId: "DEVICE123",
        },
      });

      const rotatedStoragePaths = resolveDefaultStoragePaths({
        accessToken: "secret-token-new",
        deviceId: "DEVICE123",
      });

      expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    },
  );

  it("scans for and prefers claimed current-token state over an unclaimed canonical root", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-old",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        currentTokenStateClaimed: true,
        deviceId: "DEVICE123",
      },
    });
    seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(readdirSync).toHaveBeenCalledOnce();
  });

  it("does not reuse a populated older token-hash root while deviceId is unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
    expect(resolvedPaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("does not reuse a populated sibling storage root from a different device", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "OLDDEVICE",
      startupVerificationDeviceId: "OLDDEVICE",
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("does not reuse a populated sibling storage root with ambiguous device metadata", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("keeps the current-token storage root stable after deviceId backfill when startup claimed state there", () => {
    const { stateDir, canonicalPaths } = setupCurrentTokenBackfillScenario({
      currentRootFiles: "thread-bindings",
      oldRootFiles: "crypto-only",
    });

    repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    expect(readStorageMeta(canonicalPaths.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
    const startupPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    expect(startupPaths.rootDir).toBe(canonicalPaths.rootDir);
    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(canonicalPaths.rootDir);
  });

  it("does not keep the current-token storage root sticky when only marker files exist after backfill", () => {
    const { stateDir, oldStoragePaths } = setupCurrentTokenBackfillScenario({
      currentRootFiles: "startup-verification",
      oldRootFiles: "thread-bindings",
    });

    repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(oldStoragePaths.rootDir);
  });
});
