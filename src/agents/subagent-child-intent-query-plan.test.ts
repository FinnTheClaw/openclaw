import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { expireSubagentReservationsAtomically } from "./subagent-registry-state.js";
import { reserveSubagentChildIntent, resetSubagentRegistryForTests } from "./subagent-registry.js";

const tempDirs: string[] = [];
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let stateDir: string;

function explain(db: DatabaseSync, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: unknown }>)
    .map((row) => (typeof row.detail === "string" ? row.detail : ""))
    .join("\n");
}

afterAll(() => cleanupTempDirs(tempDirs));
beforeEach(() => {
  stateDir = makeTempDir(tempDirs, "openclaw-child-intent-plan-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetSubagentRegistryForTests({ persist: false });
});
afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
});

describe("child intent lifecycle query plans", () => {
  it("uses the controller composite authority for canonical lookups", () => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const detail = explain(
      database.db,
      `SELECT intent_id FROM subagent_child_intents
        WHERE controller_session_key = 'agent:main:main'
          AND canonical_key = 'child-intent'
          AND operation_key IS NULL`,
    );
    expect(detail).toMatch(/SEARCH subagent_child_intents USING (INDEX|COVERING INDEX)/);
    expect(detail).toMatch(/controller_session_key=.*canonical_key/);
    expect(detail).not.toMatch(/SCAN subagent_child_intents/);
  });

  it("retains named terminal identities while pruning anonymous tombstones", () => {
    const base = {
      childSessionKey: "agent:main:subagent:retention",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "retention",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const named = reserveSubagentChildIntent({
      ...base,
      childIntentKey: "named-terminal-intent",
      reservationRunId: "named-terminal-run",
      operationKey: "named-operation",
    });
    const anonymous = reserveSubagentChildIntent({
      ...base,
      childIntentKey: "anonymous-terminal-intent",
      reservationRunId: "anonymous-terminal-run",
    });
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (const intent of [named, anonymous]) {
      database.db
        .prepare(
          "UPDATE subagent_child_intents SET state = 'terminal', updated_at = ? WHERE canonical_key = ?",
        )
        .run(old, intent.childIntentKey);
    }
    expireSubagentReservationsAtomically();
    expect(
      database.db
        .prepare("SELECT operation_key FROM subagent_child_intents WHERE canonical_key = ?")
        .get(named.childIntentKey),
    ).toBeTruthy();
    expect(
      database.db
        .prepare("SELECT operation_key FROM subagent_child_intents WHERE canonical_key = ?")
        .get(anonymous.childIntentKey),
    ).toBeUndefined();
    expect(
      reserveSubagentChildIntent({
        ...base,
        childIntentKey: named.childIntentKey,
        reservationRunId: "named-retry",
        operationKey: "named-operation",
      }).disposition,
    ).toBe("duplicate");
  });
});
