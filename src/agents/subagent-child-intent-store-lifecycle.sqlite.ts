import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { ChildIntentState } from "./subagent-child-intent-store.sqlite.js";

type ChildIntentTable = DB["subagent_child_intents"];
type ChildIntentRow = Selectable<ChildIntentTable>;
type ChildIntentDatabase = Pick<DB, "subagent_child_intents">;
type ChildIntentUpdate = Updateable<ChildIntentTable>;

function updateRow(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  row: ChildIntentRow,
  values: ChildIntentUpdate,
  expectedState?: ChildIntentState,
): boolean {
  const result = executeSqliteQuerySync(
    database,
    db
      .updateTable("subagent_child_intents")
      .set(values)
      .where("intent_id", "=", row.intent_id)
      .where("generation", "=", row.generation)
      .where("state", "=", expectedState ?? (row.state as ChildIntentState)),
  );
  return Number(result.numAffectedRows ?? 0) === 1;
}

export function removeSubagentReservationAtomically(params: {
  childIntentKey: string;
  reservationOwnerToken?: string;
  onlyExpired?: boolean;
  allowUnknown?: boolean;
}): boolean {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", params.childIntentKey),
    ).rows[0];
    if (!row) {
      return;
    }
    const removable = params.onlyExpired
      ? row.state === "reserved"
      : ["reserved", "dispatch_claimed"].includes(row.state) ||
        (params.allowUnknown === true && row.state === "gateway_accepted");
    if (
      !removable ||
      (params.reservationOwnerToken && row.lease_owner !== params.reservationOwnerToken)
    ) {
      return;
    }
    if (params.onlyExpired && (row.lease_expires_at ?? Number.POSITIVE_INFINITY) > Date.now()) {
      return;
    }
    const result = executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("subagent_child_intents")
        .where("intent_id", "=", row.intent_id)
        .where("generation", "=", row.generation)
        .where("state", "=", row.state),
    );
    removed = Number(result.numAffectedRows ?? 0) === 1;
  });
  return removed;
}

export function cancelSubagentChildIntentAtomically(childIntentKey: string): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", childIntentKey),
    ).rows[0];
    if (
      !row ||
      !["reserved", "dispatch_claimed", "gateway_accepted", "registered"].includes(row.state)
    ) {
      return;
    }
    changed = updateRow(db, stateDb, row, {
      state: "cancelled_requested",
      generation: row.generation + 1,
      cancel_requested_at: Date.now(),
      updated_at: Date.now(),
    });
  });
  return changed;
}

export function releaseRegisteredSubagentChildIntent(runId: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("registered_run_id", "=", runId),
    ).rows[0];
    if (!row || row.state !== "registered") {
      return;
    }
    updateRow(
      db,
      stateDb,
      row,
      {
        state: "terminal",
        generation: row.generation + 1,
        updated_at: Date.now(),
      },
      "registered",
    );
  });
}

export function expireSubagentReservationsAtomically(now = Date.now()): string[] {
  const expired: string[] = [];
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("state", "=", "reserved")
        .where("lease_expires_at", "<=", now),
    ).rows;
    for (const row of rows) {
      if (
        updateRow(
          db,
          stateDb,
          row,
          {
            state: "expired",
            generation: row.generation + 1,
            updated_at: now,
          },
          "reserved",
        )
      ) {
        expired.push(row.reservation_run_id);
      }
    }
  });
  return expired;
}
