// State database permission hardening tests cover best-effort chmod on
// filesystems without POSIX permission support (Azure Files, NFS, certain
// Docker volume drivers).
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// The permission helper hardens via the named import `chmodSync` from node:fs.
// A namespace `vi.spyOn(fs, ...)` cannot rebind an
// already-captured named import, so we mock node:fs and route chmodSync
// (named + default) through a single controllable failure hook.
const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: 0,
  failProbe: true,
  removeTargetSuffix: undefined as string | undefined,
  targets: [] as string[],
  latePath: undefined as string | undefined,
  lateDb: undefined as import("node:sqlite").DatabaseSync | undefined,
  lateMaintenance: undefined as import("../infra/sqlite-wal.js").SqliteWalMaintenance | undefined,
  lateClose: undefined as
    | MockInstance<import("../infra/sqlite-wal.js").SqliteWalMaintenance["close"]>
    | undefined,
  lateReached: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls += 1;
    chmodFailHook.targets.push(String(target));
    if (
      chmodFailHook.removeTargetSuffix &&
      String(target).endsWith(chmodFailHook.removeTargetSuffix)
    ) {
      // Remove the file after existsSync reaches chmod to reproduce the exact race.
      actual.unlinkSync(String(target));
    }
    if (chmodFailHook.lateDb && String(target) === chmodFailHook.latePath) {
      chmodFailHook.lateReached = true;
      throw chmodError("EACCES");
    }
    const isProbe = String(target).includes(".openclaw-chmod-probe-");
    if (chmodFailHook.error && (chmodFailHook.failProbe || !isProbe)) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

vi.mock("../infra/sqlite-wal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-wal.js")>();
  return {
    ...actual,
    configureSqliteConnectionPragmas: (
      ...args: Parameters<typeof actual.configureSqliteConnectionPragmas>
    ) => {
      const maintenance = actual.configureSqliteConnectionPragmas(...args);
      if (args[1]?.databasePath === chmodFailHook.latePath) {
        chmodFailHook.lateDb = args[0];
        chmodFailHook.lateMaintenance = maintenance;
        chmodFailHook.lateClose = vi.spyOn(maintenance, "close");
      }
      return maintenance;
    },
  };
});

const fs = await import("node:fs");
const {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} = await import("./openclaw-state-db.js");

function chmodError(code: string): Error {
  const err = new Error(`${code}: chmod failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function enotsupError(): Error {
  return chmodError("ENOTSUP");
}

describe("state database permission hardening without chmod support", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      chmodFailHook.error = undefined;
      chmodFailHook.calls = 0;
      chmodFailHook.failProbe = true;
      chmodFailHook.removeTargetSuffix = undefined;
      chmodFailHook.targets = [];
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  it("opens the state database when chmodSync throws ENOTSUP", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    chmodFailHook.error = enotsupError();

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
    // Hardening ran and failed; the failure must stay non-fatal.
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("rethrows EPERM when existing permissions are too broad", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");
    chmodFailHook.failProbe = false;

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EPERM/,
    );
  });

  it("opens when EPERM leaves existing permissions restrictive", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("EPERM");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("opens when EROFS leaves existing permissions restrictive", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("EROFS");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("rethrows EROFS when existing permissions are too broad", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EROFS");

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EROFS/,
    );
  });

  it("opens when the filesystem probe also rejects chmod with EPERM", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("rethrows unexpected chmod errors at open", () => {
    // EACCES is not in CHMOD_UNSUPPORTED_CODES: a real permission fault on a
    // POSIX filesystem must keep the credentials-adjacent hardening fatal.
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    chmodFailHook.error = chmodError("EACCES");

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EACCES/,
    );
  });

  it("closes the native database and WAL owner when final permission hardening fails", () => {
    const stateDir = tempDirs.make("openclaw-state-late-chmod-");
    chmodFailHook.latePath = join(stateDir, "state", "openclaw.sqlite");
    try {
      expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
        /EACCES/,
      );
      expect(chmodFailHook.lateReached).toBe(true);
      const database = chmodFailHook.lateDb;
      expect(database).toBeDefined();
      // This is the actual native handle, not a replacement SQLite implementation.
      expect
        .soft(database?.isOpen, "failed open must release the native SQLite handle")
        .toBe(false);
      expect
        .soft(chmodFailHook.lateClose, "failed open must release its real WAL maintenance owner")
        .toHaveBeenCalledTimes(1);
      if (database?.isOpen) {
        expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({
          journal_mode: "wal",
        });
        expect(
          database
            .prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'")
            .get()?.tables,
        ).toBeGreaterThan(0);
      }
    } finally {
      // Close the real resources even on the unfixed failure, before fixture removal.
      chmodFailHook.latePath = undefined;
      chmodFailHook.lateMaintenance?.close();
      if (chmodFailHook.lateDb?.isOpen) {
        chmodFailHook.lateDb.close();
      }
      chmodFailHook.lateClose?.mockRestore();
      chmodFailHook.lateDb = undefined;
      chmodFailHook.lateMaintenance = undefined;
      chmodFailHook.lateClose = undefined;
      chmodFailHook.lateReached = false;
    }
  });

  it.each(["-wal", "-shm", "-journal"])(
    "opens when the %s sidecar disappears before chmod",
    (suffix) => {
      const stateDir = tempDirs.make("openclaw-state-chmod-");
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
      const sidecarPath = join(stateDir, "state", `openclaw.sqlite${suffix}`);
      fs.writeFileSync(sidecarPath, "");
      chmodFailHook.removeTargetSuffix = suffix;

      const database = openOpenClawStateDatabase(options);

      expect(database.db.isOpen).toBe(true);
      expect(fs.existsSync(sidecarPath)).toBe(false);
      expect(chmodFailHook.targets).toContain(sidecarPath);
    },
  );

  it("rethrows when the main database vanishes between the existence check and the chmod", () => {
    // resolveSqliteDatabaseFilePaths lists the unsuffixed database first. Losing
    // it must stay fatal: swallowing that ENOENT would fall through to a SQLite
    // open that creates a fresh empty database instead of surfacing the loss.
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.removeTargetSuffix = "openclaw.sqlite";

    expect(() => openOpenClawStateDatabase(options)).toThrow(/ENOENT/);
    // Guards against a vacuous pass if the main file were skipped before chmod.
    expect(chmodFailHook.targets.some((target) => target.endsWith("openclaw.sqlite"))).toBe(true);
  });

  it("repairs the schema when chmodSync throws ENOTSUP", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();

    chmodFailHook.error = enotsupError();

    expect(() =>
      repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    ).not.toThrow();
  });

  it("commits write transactions when chmodSync throws ENOTSUP", () => {
    const stateDir = tempDirs.make("openclaw-state-chmod-");
    chmodFailHook.error = enotsupError();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    const result = runOpenClawStateWriteTransaction((database) => {
      expect(database.db.isOpen).toBe(true);
      return "committed";
    }, options);

    expect(result).toBe("committed");
  });
});
