import type { DatabaseSync } from "node:sqlite";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";

export const OPENCLAW_STATE_SCHEMA_VERSION = 1;

export function assertSupportedStateSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database ${pathname} uses newer schema version ${userVersion}; this OpenClaw build supports ${OPENCLAW_STATE_SCHEMA_VERSION}.`,
    );
  }
}

export function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

export function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

export function ensureStateColumn(db: DatabaseSync, tableName: string, columnSql: string): boolean {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName)) {
    return false;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
  return true;
}

export function repairLegacyTaskAgentAttribution(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "requester_agent_id")) {
    return;
  }
  db.exec(`
    UPDATE task_runs
    SET
      requester_agent_id = CASE
        WHEN owner_key GLOB 'agent:*:*' THEN substr(
          owner_key,
          7,
          instr(substr(owner_key, 7), ':') - 1
        )
        WHEN requester_session_key GLOB 'agent:*:*' THEN substr(
          requester_session_key,
          7,
          instr(substr(requester_session_key, 7), ':') - 1
        )
        WHEN agent_id <> substr(
          child_session_key,
          7,
          instr(substr(child_session_key, 7), ':') - 1
        ) THEN agent_id
        ELSE NULL
      END,
      agent_id = substr(
        child_session_key,
        7,
        instr(substr(child_session_key, 7), ':') - 1
      )
    WHERE requester_agent_id IS NULL
      AND runtime IN ('subagent', 'acp')
      AND child_session_key GLOB 'agent:*:*'
      AND instr(substr(child_session_key, 7), ':') > 1
      AND (
        owner_key GLOB 'agent:*:*'
        OR requester_session_key GLOB 'agent:*:*'
        OR (
          agent_id IS NOT NULL
          AND agent_id <> substr(
            child_session_key,
            7,
            instr(substr(child_session_key, 7), ':') - 1
          )
        )
      );
  `);
}

export function repairLegacyTaskDeliveryStatuses(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "delivery_status")) {
    return;
  }
  db.exec(`
    UPDATE task_runs
    SET delivery_status = 'not_applicable'
    WHERE delivery_status = 'not-requested';
  `);
}

export function hasCanonicalAgentDatabasesPrimaryKey(db: DatabaseSync): boolean {
  if (!tableExists(db, "agent_databases")) {
    return true;
  }
  const primaryKey = tablePrimaryKeyColumns(db, "agent_databases");
  return primaryKey.length === 2 && primaryKey[0] === "agent_id" && primaryKey[1] === "path";
}

function canRepairAgentDatabasesPrimaryKey(db: DatabaseSync): boolean {
  if (!tableExists(db, "agent_databases")) {
    return false;
  }
  const requiredColumns = ["agent_id", "path", "schema_version", "last_seen_at", "size_bytes"];
  return requiredColumns.every((column) => tableHasColumn(db, "agent_databases", column));
}

export function repairAgentDatabasesCompositePrimaryKey(db: DatabaseSync): boolean {
  if (hasCanonicalAgentDatabasesPrimaryKey(db) || !canRepairAgentDatabasesPrimaryKey(db)) {
    return false;
  }
  db.exec(`
    DROP TABLE IF EXISTS agent_databases_migration_new;
    CREATE TABLE agent_databases_migration_new (
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    );
    INSERT OR REPLACE INTO agent_databases_migration_new (
      agent_id,
      path,
      schema_version,
      last_seen_at,
      size_bytes
    )
    SELECT
      agent_id,
      path,
      schema_version,
      last_seen_at,
      size_bytes
    FROM agent_databases
    WHERE agent_id IS NOT NULL AND path IS NOT NULL;
    DROP TABLE agent_databases;
    ALTER TABLE agent_databases_migration_new RENAME TO agent_databases;
  `);
  return true;
}

export function assertCanonicalStateSchemaShape(db: DatabaseSync, pathname: string): void {
  if (!hasCanonicalAgentDatabasesPrimaryKey(db)) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
    );
  }
}

export function ensureStartupMigrationCheckpointSchema(db: DatabaseSync, pathname: string): void {
  assertSupportedStateSchemaVersion(db, pathname);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      meta_key TEXT NOT NULL PRIMARY KEY,
      role TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      agent_id TEXT,
      app_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_leases (
      scope TEXT NOT NULL,
      lease_key TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER,
      heartbeat_at INTEGER,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, lease_key)
    );
    CREATE INDEX IF NOT EXISTS idx_state_leases_expiry
      ON state_leases(expires_at, scope, lease_key)
      WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_state_leases_owner
      ON state_leases(owner, updated_at DESC);
  `);
  ensureStateColumn(db, "schema_meta", "app_version TEXT");
}
