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

const ANONYMOUS_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_PRUNE_BATCH_SIZE = 100;

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
  controllerSessionKey: string;
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
        .where("controller_session_key", "=", params.controllerSessionKey)
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

export function cancelSubagentChildIntentAtomically(params: {
  childIntentKey: string;
  controllerSessionKey: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("controller_session_key", "=", params.controllerSessionKey)
        .where("canonical_key", "=", params.childIntentKey),
    ).rows[0];
    if (
      !row ||
      ![
        "reserved",
        "dispatch_claimed",
        "gateway_accepted",
        "registered",
        "legacy_ambiguous",
      ].includes(row.state)
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

/** Cancels by durable run/session identity so restart does not depend on a local map. */
export function cancelSubagentChildIntentByRunOrSessionAtomically(params: {
  runId?: string;
  childSessionKey?: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where((eb) =>
          eb.or([
            ...(params.runId ? [eb("registered_run_id", "=", params.runId)] : []),
            ...(params.childSessionKey
              ? [eb("child_session_key", "=", params.childSessionKey)]
              : []),
          ]),
        ),
    ).rows[0];
    if (
      !row ||
      ![
        "reserved",
        "dispatch_claimed",
        "gateway_accepted",
        "registered",
        "legacy_ambiguous",
      ].includes(row.state)
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

    // Unnamed canonical identities are bounded tombstones. Explicit
    // operation keys are retained indefinitely as compact identities so an
    // old named operation cannot silently recreate and redispatch after TTL.
    const cutoff = now - ANONYMOUS_TERMINAL_RETENTION_MS;
    const terminalRows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .select(["intent_id", "generation"])
        .where("state", "=", "terminal")
        .where("operation_key", "is", null)
        .where("updated_at", "<=", cutoff)
        .orderBy("updated_at", "asc")
        .limit(TERMINAL_PRUNE_BATCH_SIZE),
    ).rows;
    for (const row of terminalRows) {
      executeSqliteQuerySync(
        db,
        stateDb
          .deleteFrom("subagent_child_intents")
          .where("intent_id", "=", row.intent_id)
          .where("generation", "=", row.generation)
          .where("state", "=", "terminal")
          .where("operation_key", "is", null),
      );
    }
  });
  return expired;
}
