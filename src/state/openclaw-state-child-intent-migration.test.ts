import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { rebuildLegacyChildIntentUniqueness } from "./openclaw-state-db-additive.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

describe("child intent uniqueness migration", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-intent-migration-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    env.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rebuilds legacy table uniques without collapsing distinct named slots", () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const db = database.db;
    for (const index of [
      "idx_subagent_child_intents_active_controller",
      "idx_subagent_child_intents_controller_canonical",
      "idx_subagent_child_intents_registered_run",
      "uq_subagent_child_intents_controller_operation",
      "uq_subagent_child_intents_controller_canonical",
    ]) {
      db.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    db.exec("ALTER TABLE subagent_child_intents RENAME TO subagent_child_intents_legacy");
    db.exec(`
      CREATE TABLE subagent_child_intents (
        intent_id TEXT NOT NULL PRIMARY KEY,
        controller_session_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        operation_key TEXT,
        request_digest TEXT NOT NULL,
        preparation_digest TEXT NOT NULL DEFAULT '',
        resolved_digest TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        child_session_key TEXT NOT NULL,
        reservation_run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at INTEGER,
        registered_run_id TEXT,
        provider_run_id TEXT,
        gateway_receipt_id TEXT,
        cancel_requested_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(controller_session_key, canonical_key),
        UNIQUE(controller_session_key, operation_key)
      )
    `);
    rebuildLegacyChildIntentUniqueness(db);

    db.prepare(
      `INSERT INTO subagent_child_intents
       (intent_id, controller_session_key, canonical_key, operation_key,
        request_digest, preparation_digest, resolved_digest, target_agent_id,
        child_session_key, reservation_run_id, state, generation, lease_owner,
        created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?, '{}')`,
    ).run(
      "named-a",
      "controller",
      "same-canonical",
      "slot-a",
      "request-a",
      "prepare-a",
      "resolved-a",
      "target",
      "child-a",
      "run-a",
      "lease-a",
      Date.now(),
      Date.now(),
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO subagent_child_intents
           (intent_id, controller_session_key, canonical_key, operation_key,
            request_digest, preparation_digest, resolved_digest, target_agent_id,
            child_session_key, reservation_run_id, state, generation, lease_owner,
            created_at, updated_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?, '{}')`,
        )
        .run(
          "named-b",
          "controller",
          "same-canonical",
          "slot-b",
          "request-b",
          "prepare-b",
          "resolved-b",
          "target",
          "child-b",
          "run-b",
          "lease-b",
          Date.now(),
          Date.now(),
        ),
    ).not.toThrow();

    const indexes = db.prepare("PRAGMA index_list('subagent_child_intents')").all() as Array<{
      name?: string;
      partial?: number;
    }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uq_subagent_child_intents_controller_operation",
          partial: 1,
        }),
        expect.objectContaining({
          name: "uq_subagent_child_intents_controller_canonical",
          partial: 1,
        }),
      ]),
    );
  });
});
