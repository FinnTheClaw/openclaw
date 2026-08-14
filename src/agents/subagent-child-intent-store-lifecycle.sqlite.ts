import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { compactSubagentChildIntentPayload } from "./subagent-child-intent-compaction.js";
import type { ChildIntentState } from "./subagent-child-intent-types.js";
import {
  readGatewayAcceptanceReceiptFromDatabase,
  requestGatewayAcceptanceCancelInDatabase,
} from "./subagent-gateway-acceptance-receipt-store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ChildIntentTable = DB["subagent_child_intents"];
type ChildIntentRow = Selectable<ChildIntentTable>;
type ChildIntentDatabase = Pick<
  DB,
  "subagent_child_intents" | "subagent_gateway_acceptance_receipts"
>;
type ChildIntentUpdate = Updateable<ChildIntentTable>;

const ANONYMOUS_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_PRUNE_BATCH_SIZE = 100;

export function commitSubagentRunRegistrationInTransaction(
  db: DatabaseSync,
  entry: SubagentRunRecord,
): boolean {
  if (!entry.childIntentKey || !entry.reservationOwnerToken) {
    return true;
  }
  const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where(
        "controller_session_key",
        "=",
        (entry.controllerSessionKey ?? entry.requesterSessionKey).trim(),
      )
      .where("canonical_key", "=", entry.childIntentKey)
      .$if(entry.childIntentOperationKey !== undefined, (query) =>
        query.where("operation_key", "=", entry.childIntentOperationKey!),
      )
      .where("lease_owner", "=", entry.reservationOwnerToken),
  ).rows[0];
  if (!row || row.lease_owner !== entry.reservationOwnerToken) {
    return false;
  }
  const receiptKey = row.gateway_receipt_id ?? row.canonical_key;
  const receipt = row.gateway_receipt_id
    ? readGatewayAcceptanceReceiptFromDatabase(db, receiptKey)
    : undefined;
  if (row.gateway_receipt_id) {
    if (
      !receipt ||
      ![
        "runnable",
        "dispatch_claimed",
        "accepted",
        "start_authorized",
        "started",
        "terminal",
      ].includes(receipt.lifecycle) ||
      receipt.intentId !== (row.gateway_receipt_id ?? row.canonical_key) ||
      receipt.controllerSessionKey !== row.controller_session_key ||
      receipt.childSessionKey !== row.child_session_key ||
      receipt.requestDigest !== row.request_digest ||
      receipt.resolvedDigest !== row.resolved_digest ||
      receipt.gatewayRunId !== entry.runId ||
      (row.provider_run_id !== null && row.provider_run_id !== entry.runId)
    ) {
      return false;
    }
  } else if (row.provider_run_id !== null && row.provider_run_id !== entry.runId) {
    return false;
  }
  if (row.state === "registered" && row.registered_run_id === entry.runId) {
    return true;
  }
  if (!["dispatch_claimed", "gateway_accepted"].includes(row.state)) {
    return false;
  }
  const result = updateRow(
    db,
    stateDb,
    row,
    {
      state: "registered",
      generation: row.generation + 1,
      registered_run_id: entry.runId,
      provider_run_id: entry.runId,
      gateway_receipt_id: receipt?.acceptanceKey ?? null,
      updated_at: Date.now(),
      payload_json: JSON.stringify(entry),
    },
    row.state as ChildIntentState,
    entry.reservationOwnerToken,
  );
  return result;
}

export function commitSubagentRunRegistrationAtomically(entry: SubagentRunRecord): boolean {
  let committed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    committed = commitSubagentRunRegistrationInTransaction(db, entry);
  });
  return committed;
}

function updateRow(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  row: ChildIntentRow,
  values: ChildIntentUpdate,
  expectedState?: ChildIntentState,
  expectedLeaseOwner?: string,
): boolean {
  let query = db
    .updateTable("subagent_child_intents")
    .set(values)
    .where("intent_id", "=", row.intent_id)
    .where("generation", "=", row.generation)
    .where("state", "=", expectedState ?? (row.state as ChildIntentState));
  if (expectedLeaseOwner) {
    query = query.where("lease_owner", "=", expectedLeaseOwner);
  }
  const result = executeSqliteQuerySync(database, query);
  return Number(result.numAffectedRows ?? 0) === 1;
}

function resolveReceiptToCancel(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  row: ChildIntentRow,
): { acceptanceKey: string; gatewayRunId: string } | undefined {
  const receipt = executeSqliteQuerySync(
    database,
    db
      .selectFrom("subagent_gateway_acceptance_receipts")
      .select(["acceptance_key", "gateway_run_id"])
      .where("acceptance_key", "=", row.gateway_receipt_id ?? row.canonical_key),
  ).rows[0];
  return receipt
    ? { acceptanceKey: receipt.acceptance_key, gatewayRunId: receipt.gateway_run_id }
    : undefined;
}

export function removeSubagentReservationAtomically(params: {
  childIntentKey: string;
  controllerSessionKey: string;
  operationKey?: string;
  reservationOwnerToken?: string;
  onlyExpired?: boolean;
  allowUnknown?: boolean;
}): boolean {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("controller_session_key", "=", params.controllerSessionKey)
        .where("canonical_key", "=", params.childIntentKey)
        .$if(params.operationKey !== undefined, (query) =>
          query.where("operation_key", "=", params.operationKey!),
        ),
    ).rows;
    if (params.operationKey === undefined && rows.length > 1) {
      throw new Error("child intent cancellation/removal requires operationKey");
    }
    const row = rows[0];
    if (!row) {
      return;
    }
    const reconciledBeforeAcceptance = (() => {
      if (params.allowUnknown !== true || row.state !== "gateway_accepted") {
        return false;
      }
      const receipt = readGatewayAcceptanceReceiptFromDatabase(
        db,
        row.gateway_receipt_id ?? row.canonical_key,
      );
      return Boolean(
        receipt &&
        (receipt.lifecycle === "not_accepted" || receipt.lifecycle === "failed_before_start") &&
        receipt.intentId === (row.gateway_receipt_id ?? row.canonical_key) &&
        receipt.controllerSessionKey === row.controller_session_key &&
        receipt.childSessionKey === row.child_session_key &&
        (row.provider_run_id === null || receipt.gatewayRunId === row.provider_run_id),
      );
    })();
    const removable = params.onlyExpired
      ? row.state === "reserved"
      : row.state === "reserved" || reconciledBeforeAcceptance;
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
  operationKey?: string;
}): boolean {
  let changed = false;
  let receiptCancellationRepaired = false;
  let receiptToCancel: { acceptanceKey: string; gatewayRunId: string } | undefined;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("controller_session_key", "=", params.controllerSessionKey)
        .where("canonical_key", "=", params.childIntentKey)
        .$if(params.operationKey !== undefined, (query) =>
          query.where("operation_key", "=", params.operationKey!),
        ),
    ).rows;
    if (params.operationKey === undefined && rows.length > 1) {
      throw new Error("child intent cancellation requires operationKey");
    }
    const row = rows[0];
    if (
      !row ||
      ![
        "reserved",
        "dispatch_claimed",
        "gateway_accepted",
        "registered",
        "legacy_ambiguous",
        "cancelled_requested",
      ].includes(row.state)
    ) {
      return;
    }
    if (row.state === "cancelled_requested") {
      receiptToCancel = resolveReceiptToCancel(db, stateDb, row);
      if (receiptToCancel) {
        receiptCancellationRepaired = requestGatewayAcceptanceCancelInDatabase(db, receiptToCancel);
      }
    } else {
      changed = updateRow(db, stateDb, row, {
        state: "cancelled_requested",
        generation: row.generation + 1,
        cancel_requested_at: Date.now(),
        updated_at: Date.now(),
        payload_json: compactSubagentChildIntentPayload({
          ...row,
          generation: row.generation + 1,
        }),
      });
      if (changed) {
        receiptToCancel = resolveReceiptToCancel(db, stateDb, row);
        if (receiptToCancel) {
          receiptCancellationRepaired = requestGatewayAcceptanceCancelInDatabase(
            db,
            receiptToCancel,
          );
        }
      }
    }
  });
  return changed || receiptCancellationRepaired;
}

/** Cancels by durable run/session identity so restart does not depend on a local map. */
export function cancelSubagentChildIntentByRunOrSessionAtomically(params: {
  runId?: string;
  childSessionKey?: string;
}): boolean {
  let changed = false;
  let receiptCancellationRepaired = false;
  let receiptToCancel: { acceptanceKey: string; gatewayRunId: string } | undefined;
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
        "cancelled_requested",
      ].includes(row.state)
    ) {
      return;
    }
    if (row.state === "cancelled_requested") {
      receiptToCancel = resolveReceiptToCancel(db, stateDb, row);
      if (receiptToCancel) {
        receiptCancellationRepaired = requestGatewayAcceptanceCancelInDatabase(db, receiptToCancel);
      }
    } else {
      changed = updateRow(db, stateDb, row, {
        state: "cancelled_requested",
        generation: row.generation + 1,
        cancel_requested_at: Date.now(),
        updated_at: Date.now(),
        payload_json: compactSubagentChildIntentPayload({
          ...row,
          generation: row.generation + 1,
        }),
      });
      if (changed) {
        receiptToCancel = resolveReceiptToCancel(db, stateDb, row);
        if (receiptToCancel) {
          receiptCancellationRepaired = requestGatewayAcceptanceCancelInDatabase(
            db,
            receiptToCancel,
          );
        }
      }
    }
  });
  return changed || receiptCancellationRepaired;
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
    if (!row || !["registered", "cancelled_requested"].includes(row.state)) {
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
        payload_json: compactSubagentChildIntentPayload({
          ...row,
          generation: row.generation + 1,
        }),
      },
      row.state as ChildIntentState,
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
            payload_json: compactSubagentChildIntentPayload({
              ...row,
              generation: row.generation + 1,
            }),
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
        .where("state", "in", ["terminal", "expired"])
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
          .where("state", "in", ["terminal", "expired"])
          .where("operation_key", "is", null),
      );
    }
  });
  return expired;
}
