import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  gatewayAcceptanceReceiptBindingDigest,
  type GatewayAcceptanceReceiptEnvelope,
} from "./subagent-gateway-acceptance-receipt-auth.js";
import {
  defaultReceiptEnvelope,
  signedReceiptValues,
} from "./subagent-gateway-acceptance-receipt-persistence-values.js";
import {
  fromRow,
  readGatewayAcceptanceReceipt,
  readGatewayAcceptanceReceiptFromDatabase,
  readRow,
  type GatewayAcceptanceReceipt,
  type ReceiptDb,
  type ReceiptRow,
} from "./subagent-gateway-acceptance-receipt-read.sqlite.js";
import type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";
import {
  bindReceiptToChildIntentInTransaction,
  findReceiptBoundChildIntent,
} from "./subagent-gateway-child-intent-binding.sqlite.js";

export type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";
export { readGatewayAcceptanceReceipt, readGatewayAcceptanceReceiptFromDatabase };
export type { GatewayAcceptanceReceipt };
export * from "./subagent-gateway-acceptance-receipt-transitions.sqlite.js";

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
    const childMatch = params.envelope
      ? findReceiptBoundChildIntent(db, stateDb, {
          controllerSessionKey: params.controllerSessionKey,
          acceptanceKey: params.acceptanceKey,
          envelope: params.envelope,
        })
      : { row: undefined, ambiguous: false };
    const childIntent = childMatch.row;
    if (childMatch.ambiguous) {
      throw new Error("GOVERNOR_CHILD_INTENT_BINDING_AMBIGUOUS");
    }
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
        if (
          !bindReceiptToChildIntentInTransaction(db, stateDb, {
            controllerSessionKey: params.controllerSessionKey,
            acceptanceKey: params.acceptanceKey,
            envelope,
          })
        ) {
          throw new Error("GOVERNOR_CHILD_INTENT_RECEIPT_BINDING_LOST");
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
      if (
        params.envelope &&
        !bindReceiptToChildIntentInTransaction(db, stateDb, {
          controllerSessionKey: params.controllerSessionKey,
          acceptanceKey: params.acceptanceKey,
          envelope: params.envelope,
        })
      ) {
        throw new Error("GOVERNOR_CHILD_INTENT_RECEIPT_BINDING_LOST");
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
    if (
      !bindReceiptToChildIntentInTransaction(db, stateDb, {
        controllerSessionKey: params.controllerSessionKey,
        acceptanceKey: params.acceptanceKey,
        envelope,
      })
    ) {
      throw new Error("GOVERNOR_CHILD_INTENT_RECEIPT_BINDING_LOST");
    }
    receipt = fromRow(row as ReceiptRow);
  });
  return receipt;
}

export { fencePriorGatewayAcceptanceReceipts } from "./subagent-gateway-acceptance-receipt-recovery.sqlite.js";
