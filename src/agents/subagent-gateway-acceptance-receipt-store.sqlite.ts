import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  gatewayAcceptanceReceiptBindingDigest,
  type GatewayAcceptanceReceiptEnvelope,
  type GatewayAcceptanceReceiptProof,
  verifyGatewayAcceptanceReceiptProof,
} from "./subagent-gateway-acceptance-receipt-auth.js";
import {
  defaultReceiptEnvelope,
  signedReceiptValues,
} from "./subagent-gateway-acceptance-receipt-persistence-values.js";
import type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";

type ReceiptRow = Selectable<DB["subagent_gateway_acceptance_receipts"]>;
type ReceiptDb = Pick<DB, "subagent_gateway_acceptance_receipts" | "subagent_child_intents">;

export type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";

const NON_REPLAYABLE_RECEIPT_LIFECYCLES = new Set<GatewayAcceptanceReceiptLifecycle>([
  "not_accepted",
  "failed_before_start",
  "terminal",
  "cancelled",
]);

/**
 * A failed-before-start receipt is the only failed lifecycle that may enter
 * a new attempt. The proof is the authenticated, durable receipt transition;
 * unknown, after-start, and cancellation states remain fenced forever.
 */
export function isGatewayAcceptanceReceiptActiveForReplay(
  lifecycle: GatewayAcceptanceReceiptLifecycle,
): boolean {
  return !NON_REPLAYABLE_RECEIPT_LIFECYCLES.has(lifecycle);
}

export type GatewayAcceptanceReceipt = {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  lifecycle: GatewayAcceptanceReceiptLifecycle;
  receiptGeneration: number;
  acceptedAt?: number;
  createdAt: number;
  updatedAt: number;
  acceptanceEpoch: string;
  envelopeDigest: string;
  envelope: GatewayAcceptanceReceiptEnvelope;
  proof: GatewayAcceptanceReceiptProof;
  cancelEpoch: number;
};

function parseEnvelope(raw: string): GatewayAcceptanceReceiptEnvelope {
  const value = JSON.parse(raw) as GatewayAcceptanceReceiptEnvelope;
  if (value?.schema !== "openclaw.gateway.acceptance.v2") {
    throw new Error("GOVERNOR_GATEWAY_RECEIPT_ENVELOPE_INVALID");
  }
  return value;
}

function fromRow(row: ReceiptRow): GatewayAcceptanceReceipt {
  const envelope = parseEnvelope(row.envelope_json);
  const receipt: GatewayAcceptanceReceipt = {
    acceptanceKey: row.acceptance_key,
    intentId: row.intent_id,
    controllerSessionKey: row.controller_session_key,
    requestDigest: row.request_digest,
    resolvedDigest: row.resolved_digest,
    gatewayRunId: row.gateway_run_id,
    childSessionKey: row.child_session_key,
    lifecycle: row.lifecycle as GatewayAcceptanceReceiptLifecycle,
    receiptGeneration: row.receipt_generation,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptanceEpoch: row.acceptance_epoch,
    envelopeDigest: row.envelope_digest,
    envelope,
    proof: {
      keyId: row.key_id,
      nonce: row.nonce,
      signature: row.signature,
      envelopeDigest: row.envelope_digest,
    },
    cancelEpoch: row.cancel_epoch,
  };
  if (
    receipt.envelope.acceptanceKey !== receipt.acceptanceKey ||
    receipt.envelope.intentId !== receipt.intentId ||
    receipt.envelope.controllerSessionKey !== receipt.controllerSessionKey ||
    receipt.envelope.requestDigest !== receipt.requestDigest ||
    receipt.envelope.resolvedDigest !== receipt.resolvedDigest ||
    receipt.envelope.gatewayRunId !== receipt.gatewayRunId ||
    receipt.envelope.childSessionKey !== receipt.childSessionKey ||
    receipt.envelope.receiptGeneration !== receipt.receiptGeneration ||
    receipt.envelope.acceptanceEpoch !== receipt.acceptanceEpoch ||
    !verifyGatewayAcceptanceReceiptProof({
      envelope,
      proof: receipt.proof,
      lifecycle: receipt.lifecycle,
      cancelEpoch: receipt.cancelEpoch,
    })
  ) {
    throw new Error("GOVERNOR_GATEWAY_RECEIPT_INVALID");
  }
  return receipt;
}

/** Reads and authenticates a receipt using an already-open state transaction. */
export function readGatewayAcceptanceReceiptFromDatabase(
  database: DatabaseSync,
  acceptanceKey: string,
): GatewayAcceptanceReceipt | undefined {
  const row = readRow(database, acceptanceKey);
  if (!row) {
    return undefined;
  }
  if (row.lifecycle === "unknown") {
    try {
      const payload = JSON.parse(row.payload_json) as { quarantineReason?: unknown };
      if (typeof payload.quarantineReason === "string") {
        return undefined;
      }
    } catch {
      // Fall through to the authenticated parser for ordinary unknown rows.
    }
  }
  return fromRow(row);
}

function readRow(database: DatabaseSync, acceptanceKey: string): ReceiptRow | undefined {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ReceiptDb>(database)
      .selectFrom("subagent_gateway_acceptance_receipts")
      .selectAll()
      .where("acceptance_key", "=", acceptanceKey),
  ).rows[0];
}

export function readGatewayAcceptanceReceipt(
  acceptanceKey: string,
): GatewayAcceptanceReceipt | undefined {
  let result: GatewayAcceptanceReceipt | undefined;
  runOpenClawStateWriteTransaction(({ db }) => {
    result = readGatewayAcceptanceReceiptFromDatabase(db, acceptanceKey);
  });
  return result;
}

/** Creates a durable pre-acceptance fence; no accepted state is written here. */
export function reserveGatewayAcceptanceReceipt(params: {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  acceptanceEpoch?: string;
  envelope?: GatewayAcceptanceReceiptEnvelope;
  now?: number;
}): GatewayAcceptanceReceipt {
  let receipt!: GatewayAcceptanceReceipt;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const existing = readRow(db, params.acceptanceKey);
    const now = params.now ?? Date.now();
    // Child cancellation and receipt creation share this transaction. If the
    // intent fence won first, no receipt may be created or advanced behind it.
    const childIntent = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .select(["state"])
        .where("controller_session_key", "=", params.controllerSessionKey)
        .where((eb) =>
          eb.or([eb("canonical_key", "=", params.intentId), eb("intent_id", "=", params.intentId)]),
        ),
    ).rows[0];
    if (
      childIntent &&
      ["cancelled_requested", "expired", "legacy_ambiguous", "terminal"].includes(childIntent.state)
    ) {
      throw new Error("GOVERNOR_CHILD_INTENT_CANCELLED");
    }
    if (existing) {
      const current = fromRow(existing);
      if (
        current.requestDigest !== params.requestDigest ||
        current.intentId !== params.intentId ||
        current.controllerSessionKey !== params.controllerSessionKey ||
        current.resolvedDigest !== params.resolvedDigest ||
        current.childSessionKey !== params.childSessionKey
      ) {
        throw new Error("gateway receipt conflicts with a different request binding");
      }
      if (
        params.envelope &&
        gatewayAcceptanceReceiptBindingDigest({
          ...params.envelope,
          gatewayRunId: params.gatewayRunId,
          receiptGeneration: current.receiptGeneration,
        }) !== gatewayAcceptanceReceiptBindingDigest(current.envelope)
      ) {
        throw new Error("gateway receipt conflicts with a different resolved binding");
      }
      if (current.lifecycle === "not_accepted" || current.lifecycle === "failed_before_start") {
        const nextGeneration = current.receiptGeneration + 1;
        const envelope = params.envelope
          ? {
              ...params.envelope,
              gatewayRunId: params.gatewayRunId,
              receiptGeneration: nextGeneration,
            }
          : defaultReceiptEnvelope({
              acceptanceKey: params.acceptanceKey,
              intentId: params.intentId,
              controllerSessionKey: params.controllerSessionKey,
              requestDigest: params.requestDigest,
              resolvedDigest: params.resolvedDigest,
              gatewayRunId: params.gatewayRunId,
              childSessionKey: params.childSessionKey,
              acceptanceEpoch: params.acceptanceEpoch ?? current.acceptanceEpoch,
              receiptGeneration: nextGeneration,
            });
        const signed = signedReceiptValues({ envelope, lifecycle: "preaccepted", cancelEpoch: 0 });
        const updated = executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("subagent_gateway_acceptance_receipts")
            .set({
              lifecycle: "preaccepted",
              gateway_run_id: params.gatewayRunId,
              receipt_generation: nextGeneration,
              accepted_at: null,
              updated_at: now,
              acceptance_epoch: envelope.acceptanceEpoch,
              cancel_epoch: 0,
              ...signed,
            })
            .where("acceptance_key", "=", params.acceptanceKey)
            .where("receipt_generation", "=", current.receiptGeneration)
            .where((eb) =>
              eb.or([
                eb("lifecycle", "=", "not_accepted"),
                eb("lifecycle", "=", "failed_before_start"),
              ]),
            ),
        );
        if (Number(updated.numAffectedRows ?? 0) !== 1) {
          throw new Error("GOVERNOR_GATEWAY_RECEIPT_RETRY_CAS_LOST");
        }
        receipt = fromRow({
          ...existing,
          lifecycle: "preaccepted",
          gateway_run_id: params.gatewayRunId,
          receipt_generation: nextGeneration,
          accepted_at: null,
          updated_at: now,
          acceptance_epoch: envelope.acceptanceEpoch,
          cancel_epoch: 0,
          ...signed,
        });
        return;
      }
      if (current.gatewayRunId !== params.gatewayRunId) {
        throw new Error("gateway receipt conflicts with an active attempt");
      }
      receipt = current;
      return;
    }
    const generation = 0;
    const envelope = params.envelope
      ? { ...params.envelope, gatewayRunId: params.gatewayRunId, receiptGeneration: generation }
      : defaultReceiptEnvelope({
          acceptanceKey: params.acceptanceKey,
          intentId: params.intentId,
          controllerSessionKey: params.controllerSessionKey,
          requestDigest: params.requestDigest,
          resolvedDigest: params.resolvedDigest,
          gatewayRunId: params.gatewayRunId,
          childSessionKey: params.childSessionKey,
          acceptanceEpoch: params.acceptanceEpoch ?? "gateway-startup",
          receiptGeneration: generation,
        });
    const signed = signedReceiptValues({ envelope, lifecycle: "preaccepted", cancelEpoch: 0 });
    const row = {
      acceptance_key: params.acceptanceKey,
      intent_id: params.intentId,
      controller_session_key: params.controllerSessionKey,
      request_digest: params.requestDigest,
      resolved_digest: params.resolvedDigest,
      gateway_run_id: params.gatewayRunId,
      child_session_key: params.childSessionKey,
      lifecycle: "preaccepted",
      receipt_generation: generation,
      accepted_at: null,
      created_at: now,
      updated_at: now,
      acceptance_epoch: envelope.acceptanceEpoch,
      cancel_epoch: 0,
      payload_json: "{}",
      ...signed,
    };
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("subagent_gateway_acceptance_receipts").values(row),
    );
    receipt = fromRow(row as ReceiptRow);
  });
  return receipt;
}

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
  const envelope = { ...current.envelope };
  const signed = signedReceiptValues({
    envelope,
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
  return transitionReceipt({ ...params, from: "accepted", to: "started" });
}

export function markGatewayAcceptanceFailedBeforeStart(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["accepted", "dispatch_claimed"],
    to: "failed_before_start",
  });
}

export function markGatewayAcceptanceFailedAfterStart(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  return transitionReceipt({
    ...params,
    from: ["accepted", "started"],
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

/**
 * Cancels a receipt while its caller already owns the state write transaction.
 * Child-intent cancellation uses this form so the intent fence and receipt
 * transition have one SQLite linearization point rather than a post-commit gap.
 */
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
    !["preaccepted", "runnable", "dispatch_claimed", "accepted", "started"].includes(
      receipt.lifecycle,
    )
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
  const nextEpoch = receipt.cancelEpoch + 1;
  return transitionReceiptInTransaction(database, stateDb, {
    ...params,
    from: receipt.lifecycle,
    to: "cancel_requested",
    cancelEpoch: nextEpoch,
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

export { fencePriorGatewayAcceptanceReceipts } from "./subagent-gateway-acceptance-receipt-recovery.sqlite.js";
