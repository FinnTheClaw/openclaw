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
  quarantineUnverifiableLegacyMemories(db);
}

function quarantineUnverifiableLegacyMemories(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): void {
  db.exec(`UPDATE governor_memories
              SET status = 'quarantined'
            WHERE status = 'verified'
              AND (verified_evidence_task_id IS NULL
                OR verified_evidence_id IS NULL
                OR verified_evidence_digest IS NULL
                OR verified_evidence_semantic_digest IS NULL)`);
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
  addIfMissing("governor_tasks", "projection_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing("governor_evidence", "claim_predicate", "TEXT NOT NULL DEFAULT ''");
  addIfMissing("governor_evidence", "claim_value_json", "TEXT NOT NULL DEFAULT 'null'");
  addIfMissing("governor_evidence", "semantic_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing("governor_evidence", "source_evidence_id", "TEXT");
  // Legacy evidence is deliberately unsigned and must fail admission verification.
  addIfMissing("governor_evidence", "admission_key_id", "TEXT NOT NULL DEFAULT 'legacy'");
  addIfMissing("governor_evidence", "admission_version", "INTEGER NOT NULL DEFAULT 0");
  addIfMissing("governor_evidence", "admission_signature", "TEXT NOT NULL DEFAULT ''");
  addIfMissing("governor_approval_grants", "approval_epoch", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_approval_grants", "authority_key_id", "TEXT NOT NULL DEFAULT 'legacy'");
  addIfMissing("governor_approval_grants", "authority_version", "INTEGER NOT NULL DEFAULT 0");
  addIfMissing("governor_approval_grants", "authority_signature", "TEXT NOT NULL DEFAULT ''");
  if (addIfMissing("governor_action_intents", "approval_required", "INTEGER NOT NULL DEFAULT 0")) {
    // The governor was not production-enabled before this migration. Fail
    // closed for any historical mutating intent whose capability policy can no
    // longer be reconstructed from the persisted row alone.
    db.exec(
      `UPDATE governor_action_intents
          SET approval_required = 1
        WHERE json_extract(proposal_json, '$.mutating') = 1`,
    );
  }
  addIfMissing(
    "governor_action_intents",
    "approval_policy_digest",
    "TEXT NOT NULL DEFAULT 'legacy-unverified'",
  );
  addIfMissing("governor_action_intents", "effect_started_at", "INTEGER");
  addIfMissing("governor_action_intents", "cancellation_requested_at", "INTEGER");
  addIfMissing("governor_action_intents", "termination_outcome", "TEXT");
  addIfMissing("governor_action_intents", "termination_evidence_digest", "TEXT");
  addIfMissing("governor_action_intents", "termination_acknowledged_at", "INTEGER");
  addIfMissing("governor_effects", "effect_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing(
    "governor_delivery_certifications",
    "implementation_digest",
    "TEXT NOT NULL DEFAULT 'legacy'",
  );
  addIfMissing("governor_delivery_dispatch_claims", "review_state", "TEXT");
  addIfMissing("governor_delivery_dispatch_claims", "review_reason_digest", "TEXT");
  addIfMissing("governor_delivery_dispatch_claims", "review_resolution_signature", "TEXT");
  addIfMissing("governor_delivery_dispatch_claims", "review_key_id", "TEXT");
  addIfMissing("governor_delivery_dispatch_claims", "review_key_version", "INTEGER");
  addIfMissing("governor_delivery_dispatch_claims", "review_updated_at", "INTEGER");
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
  addIfMissing("governor_outbox", "payload_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing("governor_outbox", "delivery_binding_digest", "TEXT");
  addIfMissing("governor_outbox", "outbox_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing("governor_events", "event_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing(
    "governor_fanout_jobs",
    "payload_digest",
    "TEXT NOT NULL DEFAULT 'legacy-unverified'",
  );
  addIfMissing("governor_fanout_jobs", "job_digest", "TEXT NOT NULL DEFAULT 'legacy-unverified'");
  addIfMissing(
    "governor_owner_ingress_receipts",
    "source_binding_ref",
    "TEXT NOT NULL DEFAULT 'legacy-unverified'",
  );
  addIfMissing("governor_owner_ingress_receipts", "claim_token_ref", "TEXT");
  addIfMissing("governor_owner_ingress_receipts", "claim_attempt_ref", "TEXT");
  addIfMissing("governor_owner_ingress_receipts", "claimed_at", "INTEGER");
  addIfMissing("governor_owner_ingress_receipts", "claim_expires_at", "INTEGER");
  addIfMissing("governor_owner_ingress_receipts", "ingested_task_id", "TEXT");
  addIfMissing("governor_owner_ingress_receipts", "revoked_at", "INTEGER");
  addIfMissing("governor_memories", "fact_key", "TEXT NOT NULL DEFAULT 'legacy-unknown'");
  addIfMissing("governor_memories", "superseded_at", "INTEGER");
  addIfMissing("governor_memories", "superseded_evidence_id", "TEXT");
  addIfMissing("governor_memories", "superseded_evidence_digest", "TEXT");
  addIfMissing("governor_memories", "superseded_reason", "TEXT");
  addIfMissing("governor_memories", "contradiction_fingerprint", "TEXT");
  addIfMissing("governor_memories", "replacement_memory_id", "TEXT");
  addIfMissing("governor_memories", "verified_evidence_task_id", "TEXT");
  addIfMissing("governor_memories", "verified_evidence_id", "TEXT");
  addIfMissing("governor_memories", "verified_evidence_digest", "TEXT");
  addIfMissing("governor_memories", "verified_evidence_semantic_digest", "TEXT");
  addIfMissing("governor_memories", "authority_generation", "INTEGER");
  addIfMissing("governor_memories", "authority_binding_digest", "TEXT");
  addIfMissing("governor_fanout_jobs", "physical_slot", "INTEGER");
  addIfMissing("governor_fanout_jobs", "objective_revision", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_fanout_jobs", "physical_generation", "INTEGER");
  addIfMissing("governor_fanout_jobs", "physical_binding_digest", "TEXT");
  addIfMissing("governor_fanout_jobs", "cancellation_disposition", "TEXT");
  addIfMissing("governor_fanout_jobs", "cancellation_requested_at", "INTEGER");
  addIfMissing("governor_fanout_jobs", "termination_outcome", "TEXT");
  addIfMissing("governor_fanout_jobs", "termination_evidence_digest", "TEXT");
  addIfMissing("governor_fanout_jobs", "termination_acknowledged_at", "INTEGER");
  addIfMissing("governor_fanin_envelopes", "objective_revision", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_fanin_reducers", "task_version", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_fanin_reducers", "objective_revision", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_fanin_reducers", "lease_epoch", "INTEGER NOT NULL DEFAULT -1");
  addIfMissing("governor_fanin_reducers", "execution_generation", "INTEGER NOT NULL DEFAULT -1");
  if (migratedEvidence) {
    db.exec("DROP INDEX IF EXISTS idx_governor_evidence_task");
  }
}
