import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSqliteBusyTimeout, shouldReportSqliteLockFailure } from "./sqlite-busy-timeout.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("runWithSqliteBusyTimeout", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("restores the previous timeout after success and failure", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA busy_timeout = 5000");

    expect(
      runWithSqliteBusyTimeout(database, 0, () => database?.prepare("PRAGMA busy_timeout").get()),
    ).toEqual({ timeout: 0 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });

    expect(() =>
      runWithSqliteBusyTimeout(database!, 25, () => {
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid timeout %s",
    (timeout) => {
      database = new DatabaseSync(":memory:");
      expect(() => runWithSqliteBusyTimeout(database!, timeout, () => undefined)).toThrow(
        "busyTimeoutMs must be a non-negative integer",
      );
    },
  );

  it.each([
    {
      name: "initial failure clears root suppression",
      phase: "initial",
      outer: undefined,
      inner: "suppress",
    },
    {
      name: "initial failure clears root reporting override",
      phase: "initial",
      outer: undefined,
      inner: "report",
    },
    {
      name: "initial failure preserves default reporting",
      phase: "initial",
      outer: undefined,
      inner: undefined,
    },
    {
      name: "initial failure restores outer suppression",
      phase: "initial",
      outer: "suppress",
      inner: "report",
    },
    {
      name: "initial failure restores outer reporting",
      phase: "initial",
      outer: "report",
      inner: "suppress",
    },
    {
      name: "restoration failure clears root suppression",
      phase: "restoration",
      outer: undefined,
      inner: "suppress",
    },
    {
      name: "restoration failure clears root reporting override",
      phase: "restoration",
      outer: undefined,
      inner: "report",
    },
    {
      name: "restoration failure preserves default reporting",
      phase: "restoration",
      outer: undefined,
      inner: undefined,
    },
    {
      name: "restoration failure restores outer suppression",
      phase: "restoration",
      outer: "suppress",
      inner: "report",
    },
    {
      name: "restoration failure restores outer reporting",
      phase: "restoration",
      outer: "report",
      inner: "suppress",
    },
  ] as const)("$name", ({ phase, outer, inner }) => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA busy_timeout = 5000");
    const originalExec = database.exec.bind(database);
    let pragmaSets = 0;
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.startsWith("PRAGMA busy_timeout = ")) {
        pragmaSets += 1;
        if (pragmaSets === (phase === "initial" ? 1 : 2)) {
          throw new Error(`${phase} PRAGMA failed`);
        }
      }
      return originalExec(sql);
    });

    let operationCalled = false;
    let caught: unknown;
    let reportingInsideOuter: boolean | undefined;
    const attempt = () => {
      try {
        runWithSqliteBusyTimeout(
          database!,
          0,
          () => {
            operationCalled = true;
          },
          inner ? { lockFailureReporting: inner } : {},
        );
      } catch (error) {
        caught = error;
      }
      reportingInsideOuter = shouldReportSqliteLockFailure(database!);
    };

    if (outer) {
      runWithSqliteBusyTimeout(database, 5000, attempt, { lockFailureReporting: outer });
    } else {
      attempt();
    }

    expect({
      error: caught instanceof Error ? caught.message : null,
      operationCalled,
      reportingInsideOuter,
      reportingAfterScope: shouldReportSqliteLockFailure(database),
    }).toEqual({
      error: `${phase} PRAGMA failed`,
      operationCalled: phase === "restoration",
      reportingInsideOuter: outer !== "suppress",
      reportingAfterScope: true,
    });
  });

  it("suppresses expected lock warnings only for the scoped attempt", () => {
    const databasePath = path.join(tempDirs.make("sqlite-busy-timeout-"), "state.sqlite");
    database = new DatabaseSync(databasePath);
    const contender = new DatabaseSync(databasePath);
    const logger = { warn: vi.fn() };
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      expect(() =>
        runWithSqliteBusyTimeout(
          database!,
          0,
          () =>
            runSqliteImmediateTransactionSync(database!, () => undefined, {
              busyTimeoutMs: 0,
              logger,
            }),
          { lockFailureReporting: "suppress" },
        ),
      ).toThrow();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      contender.exec("ROLLBACK");
      contender.close();
    }
  });
});
