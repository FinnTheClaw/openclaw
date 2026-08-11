// OpenClaw state database lifecycle, permissions, and migration orchestration.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  configureSqliteConnectionPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureAdditiveStateColumns } from "./openclaw-state-db-additive.js";
import {
  assertCanonicalStateSchemaShape,
  assertSupportedStateSchemaVersion,
  ensureStartupMigrationCheckpointSchema,
  hasCanonicalAgentDatabasesPrimaryKey,
  OPENCLAW_STATE_SCHEMA_VERSION,
  repairAgentDatabasesCompositePrimaryKey,
} from "./openclaw-state-db-schema-utils.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

export { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-schema-utils.js";

export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 30_000;
const OPENCLAW_STATE_DIR_MODE = 0o700;
const OPENCLAW_STATE_FILE_MODE = 0o600;

export type OpenClawStateDatabase = {
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawStateDatabaseOptions = {
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export type OpenClawStateDatabaseSchemaMigration = {
  kind: "agent-databases-composite-primary-key";
  path: string;
};

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;

const cachedDatabases = new Map<string, OpenClawStateDatabase>();
const stateDbLog = createSubsystemLogger("state/db");
const chmodWarnedTargets = new Set<string>();

function bestEffortChmodSync(target: string, mode: number): void {
  const result = applyPrivateModeSync(target, mode);
  if (result.applied || chmodWarnedTargets.has(target)) {
    return;
  }
  chmodWarnedTargets.add(target);
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

export function ensureOpenClawStatePermissions(pathname: string, env: NodeJS.ProcessEnv): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  const isDefaultStateDatabase =
    path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  if (isDefaultStateDatabase || !dirExisted) {
    bestEffortChmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      bestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
    }
  }
}

function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

export function detectOpenClawStateDatabaseSchemaMigrations(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabaseSchemaMigration[] {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return [];
  }
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname, { readOnly: true });
  try {
    return hasCanonicalAgentDatabasesPrimaryKey(db)
      ? []
      : [{ kind: "agent-databases-composite-primary-key", path: pathname }];
  } finally {
    db.close();
  }
}

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  try {
    assertSupportedStateSchemaVersion(db, pathname);
    const repaired = runSqliteImmediateTransactionSync(db, () =>
      repairAgentDatabasesCompositePrimaryKey(db),
    );
    return repaired
      ? {
          changes: ["Migrated shared state agent database registry primary key → agent_id,path"],
          warnings: [],
        }
      : { changes: [], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${String(error)}`],
    };
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  try {
    ensureStartupMigrationCheckpointSchema(db, pathname);
    return callback(db);
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  assertSupportedStateSchemaVersion(db, pathname);
  ensureAdditiveStateColumns(db);
  assertCanonicalStateSchemaShape(db, pathname);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  ensureAdditiveStateColumns(db);
  db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  const now = Date.now();
  const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("schema_meta")
      .values({
        meta_key: "primary",
        role: "global",
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
        agent_id: null,
        app_version: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          role: "global",
          schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
          agent_id: null,
          app_version: null,
          updated_at: now,
        }),
      ),
  );
}

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    return cached;
  }
  if (cached) {
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }

  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "openclaw-state",
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureSchema(db, pathname);
      return maintenance;
    } catch (error) {
      maintenance?.close();
      db.close();
      throw error;
    }
  })();
  ensureOpenClawStatePermissions(pathname, env);
  const database = { db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  return database;
}

export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const database = openOpenClawStateDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database));
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write committed; never encourage a caller to retry an applied mutation.
  }
  return result;
}

export function closeOpenClawStateDatabase(): void {
  for (const database of cachedDatabases.values()) {
    if (database.db.isOpen) {
      database.walMaintenance.checkpoint();
    }
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    if (database.db.isOpen) {
      database.db.close();
    }
  }
  cachedDatabases.clear();
}

export function isOpenClawStateDatabaseOpen(): boolean {
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

export const closeOpenClawStateDatabaseForTest = closeOpenClawStateDatabase;
