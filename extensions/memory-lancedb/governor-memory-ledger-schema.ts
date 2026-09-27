import type { DatabaseSync } from "node:sqlite";

/** Creates and upgrades only the governor-owned tables in the shared memory DB. */
export function initializeGovernorMemoryLedgerSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_governor_high_water (
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'tombstone')),
      revision_id TEXT,
      source_evidence_digest TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      retirement_decision_id TEXT,
      retirement_binding_digest TEXT,
      retirement_reason TEXT,
      authority_key_id TEXT,
      PRIMARY KEY(agent_id, scope, fact_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_governor_remediations (
      remediation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      stale_revision_id TEXT NOT NULL,
      replacement_revision_id TEXT,
      source_evidence_id TEXT NOT NULL,
      source_evidence_digest TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('completed', 'pending')),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_governor_remediation_ready
      ON memory_governor_remediations(state, updated_at);
    CREATE TABLE IF NOT EXISTS memory_governor_lineage (
      memory_id TEXT NOT NULL,
      source_memory_id TEXT NOT NULL DEFAULT '',
      source_evidence_id TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      relation_kind TEXT NOT NULL DEFAULT 'primary' CHECK(relation_kind IN ('primary', 'memory', 'evidence')),
      PRIMARY KEY(memory_id, source_memory_id, source_evidence_id, scope_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_governor_lineage_source
      ON memory_governor_lineage(scope_key, source_evidence_id, memory_id);
  `);
  for (const statement of [
    "ALTER TABLE memory_governor_high_water ADD COLUMN retirement_decision_id TEXT",
    "ALTER TABLE memory_governor_high_water ADD COLUMN retirement_binding_digest TEXT",
    "ALTER TABLE memory_governor_high_water ADD COLUMN retirement_reason TEXT",
    "ALTER TABLE memory_governor_high_water ADD COLUMN authority_key_id TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Existing current schemas already expose the signed-retirement columns.
    }
  }
  try {
    db.exec("ALTER TABLE memory_governor_lineage ADD COLUMN source_memory_id TEXT");
  } catch {
    // Existing lineage tables already expose the compatibility column.
  }
  try {
    db.exec("ALTER TABLE memory_governor_lineage ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''");
  } catch {
    // Existing lineage tables already expose the scope column.
  }
  try {
    db.exec(
      "ALTER TABLE memory_governor_lineage ADD COLUMN relation_kind TEXT NOT NULL DEFAULT 'primary'",
    );
  } catch {
    // Existing lineage tables already expose the relation kind column.
  }
  db.exec(
    "UPDATE memory_governor_lineage SET source_memory_id = '' WHERE source_memory_id IS NULL",
  );
  db.exec(
    "UPDATE memory_governor_lineage SET relation_kind = CASE WHEN source_memory_id != '' THEN 'memory' " +
      "WHEN source_evidence_id = json_extract((SELECT metadata_json FROM memory_fact_revisions WHERE revision_id = memory_governor_lineage.memory_id), '$.governor.sourceEvidenceId') THEN 'primary' " +
      "ELSE 'evidence' END WHERE relation_kind = 'primary'",
  );
}
