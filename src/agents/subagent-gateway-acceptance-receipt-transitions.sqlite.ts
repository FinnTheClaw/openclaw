import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { settleGatewayAcceptanceFailedBeforeStartInDatabase } from "./subagent-gateway-acceptance-failed-before-start.sqlite.js";
import { signedReceiptValues } from "./subagent-gateway-acceptance-receipt-persistence-values.js";
import {
  fromRow,
  readGatewayAcceptanceReceipt,
  readRow,
  type ReceiptDb,
} from "./subagent-gateway-acceptance-receipt-read.sqlite.js";
import type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";

function transitionReceiptInTransaction(
  database: DatabaseSync,
  stateDb: Kysely<ReceiptDb>,
  params: {
    acceptanceKey: string;
    gatewayRunId: string;
    from: GatewayAcceptanceReceiptLifecycle | readonly GatewayAcceptanceReceiptLifecycle[];
    to: GatewayAcceptanceReceiptLifecycle;
    receiptGeneration?: number;
    cancelEpoch?: number;
    acceptedAt?: number | null;
  },
): boolean {
  const row = readRow(database, params.acceptanceKey);
  if (!row) {
    return false;
  }
  const current = fromRow(row);
  if (
    current.gatewayRunId !== params.gatewayRunId ||
    (params.receiptGeneration !== undefined &&
      current.receiptGeneration !== params.receiptGeneration) ||
    (Array.isArray(params.from)
      ? !params.from.includes(current.lifecycle)
      : current.lifecycle !== params.from)
  ) {
    return false;
  }
  if (params.to === "dispatch_claimed" || params.to === "accepted") {
    const child = executeSqliteQuerySync(
      database,
      stateDb
        .selectFrom("subagent_child_intents")
        .select(["state"])
        .where("controller_session_key", "=", current.controllerSessionKey)
        .where((eb) =>
          eb.or([
            eb("canonical_key", "=", current.intentId),
            eb("intent_id", "=", current.intentId),
          ]),
        ),
    ).rows[0];
    if (
      child &&
      ["cancelled_requested", "expired", "legacy_ambiguous", "terminal"].includes(child.state)
    ) {
      return false;
    }
  }
  const cancelEpoch = params.cancelEpoch ?? current.cancelEpoch;
  const signed = signedReceiptValues({
    envelope: { ...current.envelope },
    lifecycle: params.to,
    cancelEpoch,
    nonce: current.proof.nonce,
  });
  const updated = executeSqliteQuerySync(
    database,
    stateDb
      .updateTable("subagent_gateway_acceptance_receipts")
      .set({
        lifecycle: params.to,
        updated_at: Date.now(),
        cancel_epoch: cancelEpoch,
        ...(params.acceptedAt !== undefined ? { accepted_at: params.acceptedAt } : {}),
        ...signed,
      })
      .where("acceptance_key", "=", params.acceptanceKey)
      .where("gateway_run_id", "=", params.gatewayRunId)
      .where("receipt_generation", "=", current.receiptGeneration)
      .where("lifecycle", "=", current.lifecycle)
      .where("nonce", "=", current.proof.nonce),
  );
  return Number(updated.numAffectedRows ?? 0) === 1;
}

function transitionReceipt(params: {
  acceptanceKey: string;
  gatewayRunId: string;
  from: GatewayAcceptanceReceiptLifecycle | readonly GatewayAcceptanceReceiptLifecycle[];
  to: GatewayAcceptanceReceiptLifecycle;
  receiptGeneration?: number;
  cancelEpoch?: number;
  acceptedAt?: number | null;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    changed = transitionReceiptInTransaction(db, getNodeSqliteKysely<ReceiptDb>(db), params);
  });
  return changed;
}

export function markGatewayAcceptanceRunnable(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({ ...params, from: "preaccepted", to: "runnable" });
}

export function markGatewayAcceptanceDispatchClaimed(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({ ...params, from: "runnable", to: "dispatch_claimed" });
}

/** The dispatch claim is the irreversible handoff fence. */
export function isGatewayAcceptanceDispatchAllowed(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  const receipt = readGatewayAcceptanceReceipt(params.acceptanceKey);
  return Boolean(
    receipt &&
    receipt.gatewayRunId === params.gatewayRunId &&
    (receipt.lifecycle === "dispatch_claimed" || receipt.lifecycle === "accepted"),
  );
}

export function markGatewayAcceptanceAccepted(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: "dispatch_claimed",
    to: "accepted",
    acceptedAt: Date.now(),
  });
}

/** Durable just-in-time provider-start authorization. The provider act must follow this CAS. */
export function markGatewayAcceptanceStartAuthorized(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({ ...params, from: "accepted", to: "start_authorized" });
}

/** Atomically wins the handoff race against cancellation. */
export function claimGatewayAcceptanceForDispatch(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return markGatewayAcceptanceAccepted(params);
}

export function markGatewayAcceptanceStarted(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["accepted", "start_authorized"],
    to: "started",
  });
}

export function markGatewayAcceptanceFailedBeforeStart(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const currentRow = readRow(db, params.acceptanceKey);
    if (!currentRow) {
      return;
    }
    const current = fromRow(currentRow);
    changed = settleGatewayAcceptanceFailedBeforeStartInDatabase({
      database: db,
      acceptanceKey: params.acceptanceKey,
      gatewayRunId: params.gatewayRunId,
      controllerSessionKey: current.controllerSessionKey,
      intentId: current.intentId,
      transition: () =>
        transitionReceiptInTransaction(db, stateDb, {
          ...params,
          from: ["accepted", "start_authorized", "dispatch_claimed"],
          to: "failed_before_start",
        }),
    });
  });
  return changed;
}

export function markGatewayAcceptanceFailedAfterStart(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["accepted", "start_authorized", "started"],
    to: "failed_after_start",
  });
}

export function markGatewayAcceptanceNotAccepted(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["preaccepted", "runnable"],
    to: "not_accepted",
  });
}

export function requestGatewayAcceptanceCancel(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    changed = requestGatewayAcceptanceCancelInDatabase(db, params);
  });
  return changed;
}

/** Cancels a receipt while the caller owns the state write transaction. */
export function requestGatewayAcceptanceCancelInDatabase(
  database: DatabaseSync,
  params: { acceptanceKey: string; gatewayRunId: string },
): boolean {
  const stateDb = getNodeSqliteKysely<ReceiptDb>(database);
  const row = readRow(database, params.acceptanceKey);
  if (!row) {
    return false;
  }
  const receipt = fromRow(row);
  if (receipt.gatewayRunId !== params.gatewayRunId) {
    return false;
  }
  if (receipt.lifecycle === "cancel_requested" || receipt.lifecycle === "cancelled") {
    return true;
  }
  if (
    ![
      "preaccepted",
      "runnable",
      "dispatch_claimed",
      "accepted",
      "start_authorized",
      "started",
    ].includes(receipt.lifecycle)
  ) {
    return false;
  }
  const child = executeSqliteQuerySync(
    database,
    stateDb
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", receipt.controllerSessionKey)
      .where((eb) =>
        eb.or([eb("canonical_key", "=", receipt.intentId), eb("intent_id", "=", receipt.intentId)]),
      ),
  ).rows[0];
  if (
    child &&
    ![
      "reserved",
      "dispatch_claimed",
      "gateway_accepted",
      "registered",
      "legacy_ambiguous",
      "cancelled_requested",
    ].includes(child.state)
  ) {
    return false;
  }
  if (child && child.state !== "cancelled_requested") {
    const fenced = executeSqliteQuerySync(
      database,
      stateDb
        .updateTable("subagent_child_intents")
        .set({
          state: "cancelled_requested",
          generation: child.generation + 1,
          cancel_requested_at: Date.now(),
          updated_at: Date.now(),
        })
        .where("intent_id", "=", child.intent_id)
        .where("generation", "=", child.generation)
        .where("state", "=", child.state),
    );
    if (Number(fenced.numAffectedRows ?? 0) !== 1) {
      return false;
    }
  }
  return transitionReceiptInTransaction(database, stateDb, {
    ...params,
    from: receipt.lifecycle,
    to: "cancel_requested",
    cancelEpoch: receipt.cancelEpoch + 1,
  });
}

export function markGatewayAcceptanceCancelled(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({ ...params, from: "cancel_requested", to: "cancelled" });
}

export function markGatewayAcceptanceTerminal(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["started", "cancelled"],
    to: "terminal",
  });
}
