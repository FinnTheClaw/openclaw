// Verifies additive upgrades from the first governor evidence and outbox shapes.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeGovernorStateSchema } from "./state-schema.js";

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
          INSERT INTO governor_evidence VALUES
            ('legacy-evidence', 'legacy-task', 'verified', 'tool', 'legacy-source', 0, 1,
             'legacy-scope', 1, 'legacy-digest', '{}', 'admitted', NULL, 1);
          INSERT INTO governor_outbox VALUES
            ('legacy-task', 'legacy-effect', 'legacy-delivery', 0, 1, 0, 0, 'pending', '{}', 1, 1);
        `);
        initializeGovernorStateSchema(options);
        initializeGovernorStateSchema(options);
        expect(columns(db, "governor_evidence")).toContain("plan_version");
        expect(columns(db, "governor_outbox")).toEqual(
          expect.arrayContaining(["plan_version", "execution_generation"]),
        );
        const evidence = db
          .prepare("SELECT plan_version FROM governor_evidence WHERE evidence_id = ?")
          .get("legacy-evidence") as { plan_version: number };
        const outbox = db
          .prepare(
            "SELECT plan_version, execution_generation FROM governor_outbox WHERE effect_id = ?",
          )
          .get("legacy-effect") as { plan_version: number; execution_generation: number };
        expect(evidence.plan_version).toBe(-1);
        expect(outbox).toEqual({ plan_version: -1, execution_generation: -1 });
        const indexColumns = db
          .prepare("PRAGMA index_info(idx_governor_evidence_task)")
          .all() as Array<{ name: string }>;
        expect(indexColumns.map((row) => row.name)).toContain("plan_version");
        closeOpenClawStateDatabase();
      },
    );
  });
});
