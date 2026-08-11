// Verifies additive upgrades from the first governor evidence and outbox shapes.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import { GovernorSqliteStore } from "./store.js";

function columns(db: ReturnType<typeof openOpenClawStateDatabase>["db"], table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor schema migration", () => {
  it("upgrades legacy evidence and outbox fences idempotently without trusting old evidence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-legacy-schema-" },
      async (state) => {
        const options = { env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir } };
        const { db } = openOpenClawStateDatabase(options);
        db.exec(`
          CREATE TABLE governor_evidence (
            evidence_id TEXT NOT NULL PRIMARY KEY, task_id TEXT NOT NULL, criterion_id TEXT NOT NULL,
            source_kind TEXT NOT NULL, source_identity TEXT NOT NULL, task_version INTEGER NOT NULL,
            objective_revision INTEGER NOT NULL, scope_key TEXT NOT NULL, observed_at INTEGER NOT NULL,
            evidence_digest TEXT NOT NULL, payload_json TEXT NOT NULL, admissibility TEXT NOT NULL,
            invalidated_at INTEGER, created_at INTEGER NOT NULL
          );
          CREATE INDEX idx_governor_evidence_task
            ON governor_evidence(task_id, objective_revision, criterion_id, created_at, evidence_id);
          CREATE TABLE governor_outbox (
            task_id TEXT NOT NULL, effect_id TEXT NOT NULL, delivery_key TEXT NOT NULL UNIQUE,
            task_version INTEGER NOT NULL, objective_revision INTEGER NOT NULL, lease_epoch INTEGER NOT NULL,
            delivery_claim_epoch INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (task_id, effect_id)
          );
          CREATE TABLE governor_memories (
            memory_id TEXT NOT NULL PRIMARY KEY, scope_key TEXT NOT NULL, scope_epoch INTEGER NOT NULL,
            status TEXT NOT NULL, source_kind TEXT NOT NULL, source_identity TEXT NOT NULL,
            source_rank INTEGER NOT NULL, observed_at INTEGER NOT NULL, freshness_expires_at INTEGER,
            confidence REAL NOT NULL, sensitivity TEXT NOT NULL, provenance_json TEXT NOT NULL,
            content_json TEXT NOT NULL, content_digest TEXT NOT NULL, supersedes_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstoned_at INTEGER
          );
          INSERT INTO governor_evidence VALUES
            ('legacy-evidence', 'legacy-task', 'verified', 'tool', 'legacy-source', 0, 1,
             'legacy-scope', 1, 'legacy-digest', '{}', 'admitted', NULL, 1);
          INSERT INTO governor_outbox VALUES
            ('legacy-task', 'legacy-effect', 'legacy-delivery', 0, 1, 0, 0, 'pending', '{}', 1, 1);
          INSERT INTO governor_memories VALUES
            ('legacy-memory', 'legacy-scope', 0, 'verified', 'historical_memory', 'legacy-source',
             200, 1, NULL, 0.5, 'normal', '{}', '{}', 'legacy-digest', NULL, 1, 1, NULL);
        `);
        initializeGovernorStateSchema(options);
        initializeGovernorStateSchema(options);
        expect(columns(db, "governor_evidence")).toEqual(
          expect.arrayContaining([
            "plan_version",
            "claim_predicate",
            "claim_value_json",
            "semantic_digest",
          ]),
        );
        expect(columns(db, "governor_outbox")).toEqual(
          expect.arrayContaining(["plan_version", "execution_generation"]),
        );
        expect(columns(db, "governor_memories")).toEqual(
          expect.arrayContaining([
            "fact_key",
            "superseded_at",
            "superseded_evidence_id",
            "superseded_evidence_digest",
            "superseded_reason",
            "contradiction_fingerprint",
            "replacement_memory_id",
          ]),
        );
        expect(columns(db, "governor_memory_remediations")).toEqual(
          expect.arrayContaining([
            "contradiction_fingerprint",
            "canonical_source_ref",
            "replacement_memory_id",
            "investigation_count",
            "verification_evidence_digest",
          ]),
        );
        const evidence = db
          .prepare(
            "SELECT plan_version, semantic_digest FROM governor_evidence WHERE evidence_id = ?",
          )
          .get("legacy-evidence") as { plan_version: number; semantic_digest: string };
        const outbox = db
          .prepare(
            "SELECT plan_version, execution_generation FROM governor_outbox WHERE effect_id = ?",
          )
          .get("legacy-effect") as { plan_version: number; execution_generation: number };
        expect(evidence).toEqual({ plan_version: -1, semantic_digest: "legacy-unverified" });
        expect(outbox).toEqual({ plan_version: -1, execution_generation: -1 });
        expect(
          db
            .prepare("SELECT fact_key FROM governor_memories WHERE memory_id = ?")
            .get("legacy-memory"),
        ).toEqual({ fact_key: "legacy-unknown" });
        const indexColumns = db
          .prepare("PRAGMA index_info(idx_governor_evidence_task)")
          .all() as Array<{ name: string }>;
        expect(indexColumns.map((row) => row.name)).toContain("plan_version");
        closeOpenClawStateDatabase();
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        expect(() => store.listEvidence("legacy-task" as never)).toThrow(
          /opaque keyed reference|semantic digest mismatch/u,
        );
        closeOpenClawStateDatabase();
      },
    );
  });
});
