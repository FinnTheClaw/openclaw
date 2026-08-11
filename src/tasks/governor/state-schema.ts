// Lazily creates governor-only state after the explicit feature path is constructed.
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { GOVERNOR_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.generated.js";

export function initializeGovernorStateSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const { db } = openOpenClawStateDatabase(options);
  migrateLegacyGovernorColumns(db);
  db.exec(GOVERNOR_STATE_SCHEMA_SQL);
}

function migrateLegacyGovernorColumns(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): void {
  const columnsFor = (table: string): Set<string> => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    return new Set(
      rows.map((row) => row.name).filter((name): name is string => typeof name === "string"),
    );
  };
  const addIfMissing = (table: string, column: string, definition: string): boolean => {
    const columns = columnsFor(table);
    if (columns.size === 0 || columns.has(column)) {
      return false;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  };

  // Historical governor rows lack current-plan/execution fences. The -1
  // sentinel deliberately cannot satisfy a non-negative current plan or run.
  const migratedEvidence = addIfMissing(
    "governor_evidence",
    "plan_version",
    "INTEGER NOT NULL DEFAULT -1",
  );
  addIfMissing("governor_evidence", "claim_predicate", "TEXT NOT NULL DEFAULT ''");
  addIfMissing("governor_evidence", "claim_value_json", "TEXT NOT NULL DEFAULT 'null'");
  addIfMissing("governor_evidence", "semantic_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  // Legacy evidence is deliberately unsigned and must fail admission verification.
  addIfMissing("governor_evidence", "admission_key_id", "TEXT NOT NULL DEFAULT 'legacy'");
  addIfMissing("governor_evidence", "admission_version", "INTEGER NOT NULL DEFAULT 0");
  addIfMissing("governor_evidence", "admission_signature", "TEXT NOT NULL DEFAULT ''");
  addIfMissing("governor_approval_grants", "approval_epoch", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_approval_grants", "authority_key_id", "TEXT NOT NULL DEFAULT 'legacy'");
  addIfMissing("governor_approval_grants", "authority_version", "INTEGER NOT NULL DEFAULT 0");
  addIfMissing("governor_approval_grants", "authority_signature", "TEXT NOT NULL DEFAULT ''");
  addIfMissing(
    "governor_delivery_certifications",
    "implementation_digest",
    "TEXT NOT NULL DEFAULT 'legacy'",
  );
  addIfMissing(
    "governor_delivery_certifications",
    "config_digest",
    "TEXT NOT NULL DEFAULT 'legacy'",
  );
  addIfMissing(
    "governor_delivery_certifications",
    "certification_generation",
    "INTEGER NOT NULL DEFAULT -1",
  );
  addIfMissing(
    "governor_delivery_certifications",
    "authority_key_id",
    "TEXT NOT NULL DEFAULT 'legacy'",
  );
  addIfMissing(
    "governor_delivery_certifications",
    "authority_version",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addIfMissing("governor_outbox", "plan_version", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_outbox", "execution_generation", "INTEGER NOT NULL DEFAULT -1");
  if (migratedEvidence) {
    db.exec("DROP INDEX IF EXISTS idx_governor_evidence_task");
  }
}
