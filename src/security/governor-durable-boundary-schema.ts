// Explicit ownership metadata for governor raw schema, migration, and lock operations.
import type { GovernorDurableBoundary } from "./governor-durable-boundary-contract.js";

export const GOVERNOR_RAW_DURABLE_BOUNDARIES: readonly GovernorDurableBoundary[] = [
  {
    id: "governor-schema-bootstrap",
    file: "src/tasks/governor/state-schema.ts",
    symbol: "initializeGovernorStateSchema",
    direction: "write",
    enforcementAnchors: [
      "migrateLegacyGovernorColumns",
      "GOVERNOR_STATE_SCHEMA_SQL",
      "quarantineUnverifiableLegacyMemories",
    ],
    rawDurableOperation: {
      kind: "schema-bootstrap",
      schemaVersionGuard: "generated governor schema plus idempotent column-presence checks",
      transactionRule: "feature-gated bootstrap owns the shared SQLite connection",
      recoveryRule: "repeated initialization is additive and quarantines unverifiable legacy rows",
      testFile: "src/tasks/governor/state-schema.test.ts",
    },
  },
  {
    id: "governor-schema-migration",
    file: "src/tasks/governor/state-schema.ts",
    symbol: "migrateLegacyGovernorColumns",
    direction: "read-write",
    enforcementAnchors: ["PRAGMA table_info", "ALTER TABLE", "addIfMissing"],
    rawDurableOperation: {
      kind: "migration",
      schemaVersionGuard: "per-table column-presence high-water",
      transactionRule: "serialized feature bootstrap before governor store construction",
      recoveryRule: "each additive step is independently idempotent after interruption",
      testFile: "src/tasks/governor/state-schema.test.ts",
    },
  },
  {
    id: "governor-legacy-memory-quarantine",
    file: "src/tasks/governor/state-schema.ts",
    symbol: "quarantineUnverifiableLegacyMemories",
    direction: "write",
    enforcementAnchors: ["governor_memories", "quarantined", "verified_evidence_digest"],
    rawDurableOperation: {
      kind: "migration",
      schemaVersionGuard: "verified-memory provenance columns",
      transactionRule: "runs after generated schema application",
      recoveryRule: "idempotent quarantine never promotes legacy rows",
      testFile: "src/tasks/governor/state-schema.test.ts",
    },
  },
  {
    id: "governor-host-file-lock-schema",
    file: "src/security/governor-host-file-lock.ts",
    symbol: "withGovernorHostFileLock",
    direction: "read-write",
    enforcementAnchors: ["PRAGMA journal_mode", "BEGIN IMMEDIATE", "database.close"],
    rawDurableOperation: {
      kind: "coordination",
      schemaVersionGuard: "fixed governor_host_mutex schema",
      transactionRule: "BEGIN IMMEDIATE OS-backed exclusion",
      recoveryRule: "SQLite releases the lock on process death and rollback is bounded",
      testFile: "src/security/governor-host-file-lock.test.ts",
    },
  },
  {
    id: "governor-host-file-lock-rollback",
    file: "src/security/governor-host-file-lock.ts",
    symbol: "rollbackQuietly",
    direction: "write",
    enforcementAnchors: ["ROLLBACK", "Preserve the operation failure"],
    rawDurableOperation: {
      kind: "coordination",
      schemaVersionGuard: "active SQLite transaction only",
      transactionRule: "rollback is attempted only after BEGIN IMMEDIATE succeeds",
      recoveryRule: "the original failure remains authoritative if SQLite already released",
      testFile: "src/security/governor-host-file-lock.test.ts",
    },
  },
] as const;
