/**
 * Cross-process host-private exclusion backed by SQLite's OS file locks.
 *
 * The coordination database is not authority state. It may be recreated; the
 * signed anti-rollback journal remains the authority. BEGIN IMMEDIATE is
 * released by the OS when a process exits, so PID reuse cannot retain or steal
 * ownership on Windows.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LOCK_TIMEOUT_MS = 5_000;

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the operation failure. A rollback can fail only when SQLite
    // already released or never began the transaction.
  }
}

export function withGovernorHostFileLock<T>(lockPath: string, run: () => T): T {
  const directory = path.dirname(lockPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = `${lockPath}.sqlite3`;
  const database = new DatabaseSync(databasePath, {
    timeout: LOCK_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  let transactionOpen = false;
  try {
    fs.chmodSync(databasePath, 0o600);
    database.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
        "CREATE TABLE IF NOT EXISTS governor_host_mutex (id INTEGER PRIMARY KEY CHECK (id = 1));",
    );
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.prepare("INSERT OR IGNORE INTO governor_host_mutex(id) VALUES (1)").run();
    const result = run();
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      rollbackQuietly(database);
    }
    throw error;
  } finally {
    database.close();
  }
}
