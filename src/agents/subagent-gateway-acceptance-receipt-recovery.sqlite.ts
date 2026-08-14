import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createGatewayAcceptanceReceiptProof,
  verifyGatewayAcceptanceReceiptProof,
  type GatewayAcceptanceReceiptEnvelope,
} from "./subagent-gateway-acceptance-receipt-auth.js";

type ReceiptRow = Selectable<DB["subagent_gateway_acceptance_receipts"]>;
type ReceiptDb = Pick<DB, "subagent_gateway_acceptance_receipts">;
type RecoveryReceipt = {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  lifecycle: string;
  receiptGeneration: number;
  acceptedAt?: number;
  createdAt: number;
  updatedAt: number;
  acceptanceEpoch: string;
  envelopeDigest: string;
  envelope: GatewayAcceptanceReceiptEnvelope;
  proof: { keyId: string; nonce: string; signature: string; envelopeDigest: string };
  cancelEpoch: number;
};

function readAuthenticatedReceipt(
  database: DatabaseSync,
  acceptanceKey: string,
): RecoveryReceipt | undefined {
  const row = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ReceiptDb>(database)
      .selectFrom("subagent_gateway_acceptance_receipts")
      .selectAll()
      .where("acceptance_key", "=", acceptanceKey),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  let envelope: GatewayAcceptanceReceiptEnvelope;
  try {
    envelope = JSON.parse(row.envelope_json) as GatewayAcceptanceReceiptEnvelope;
  } catch {
    return undefined;
  }
  const receipt: RecoveryReceipt = {
    acceptanceKey: row.acceptance_key,
    intentId: row.intent_id,
    controllerSessionKey: row.controller_session_key,
    requestDigest: row.request_digest,
    resolvedDigest: row.resolved_digest,
    gatewayRunId: row.gateway_run_id,
    childSessionKey: row.child_session_key,
    lifecycle: row.lifecycle,
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
    envelope.acceptanceKey !== receipt.acceptanceKey ||
    envelope.intentId !== receipt.intentId ||
    envelope.controllerSessionKey !== receipt.controllerSessionKey ||
    envelope.requestDigest !== receipt.requestDigest ||
    envelope.resolvedDigest !== receipt.resolvedDigest ||
    envelope.gatewayRunId !== receipt.gatewayRunId ||
    envelope.childSessionKey !== receipt.childSessionKey ||
    envelope.receiptGeneration !== receipt.receiptGeneration ||
    envelope.acceptanceEpoch !== receipt.acceptanceEpoch ||
    !verifyGatewayAcceptanceReceiptProof({
      envelope,
      proof: receipt.proof,
      lifecycle: receipt.lifecycle,
      cancelEpoch: receipt.cancelEpoch,
    })
  ) {
    return undefined;
  }
  return receipt;
}

function quarantineUnauthenticatedReceipt(
  database: DatabaseSync,
  acceptanceKey: string,
  lifecycle: string,
): boolean {
  const stateDb = getNodeSqliteKysely<ReceiptDb>(database);
  const result = executeSqliteQuerySync(
    database,
    stateDb
      .updateTable("subagent_gateway_acceptance_receipts")
      .set({
        lifecycle: "unknown",
        updated_at: Date.now(),
        payload_json: JSON.stringify({
          quarantineReason: "GOVERNOR_GATEWAY_RECEIPT_AUTHENTICATION_UNAVAILABLE",
          priorLifecycle: lifecycle,
        }),
      })
      .where("acceptance_key", "=", acceptanceKey)
      .where("lifecycle", "=", lifecycle),
  );
  return Number(result.numAffectedRows ?? 0) === 1;
}

/** Fence accepted work from an earlier gateway lifecycle without adopting it. */
export function fencePriorGatewayAcceptanceReceipts(currentEpoch: string): number {
  let fenced = 0;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_gateway_acceptance_receipts")
        .select(["acceptance_key", "acceptance_epoch", "lifecycle"])
        .where("acceptance_epoch", "!=", currentEpoch)
        .where("lifecycle", "in", [
          "preaccepted",
          "runnable",
          "dispatch_claimed",
          "accepted",
          "start_authorized",
          "started",
          "cancel_requested",
        ]),
    ).rows as Pick<ReceiptRow, "acceptance_key" | "acceptance_epoch" | "lifecycle">[];
    for (const row of rows) {
      const current = readAuthenticatedReceipt(db, row.acceptance_key);
      if (
        !current ||
        ![
          "preaccepted",
          "runnable",
          "dispatch_claimed",
          "accepted",
          "start_authorized",
          "started",
          "cancel_requested",
        ].includes(current.lifecycle)
      ) {
        if (!current) {
          fenced += quarantineUnauthenticatedReceipt(db, row.acceptance_key, row.lifecycle) ? 1 : 0;
        }
        continue;
      }
      const proof = createGatewayAcceptanceReceiptProof({
        envelope: current.envelope,
        lifecycle: "unknown",
        cancelEpoch: current.cancelEpoch,
        nonce: current.proof.nonce,
      });
      const updated = executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("subagent_gateway_acceptance_receipts")
          .set({
            lifecycle: "unknown",
            updated_at: Date.now(),
            envelope_digest: proof.envelopeDigest,
            envelope_json: JSON.stringify(current.envelope),
            key_id: proof.keyId,
            nonce: proof.nonce,
            signature: proof.signature,
          })
          .where("acceptance_key", "=", current.acceptanceKey)
          .where("receipt_generation", "=", current.receiptGeneration)
          .where("lifecycle", "=", current.lifecycle)
          .where("nonce", "=", current.proof.nonce),
      );
      if (Number(updated.numAffectedRows ?? 0) === 1) {
        fenced += 1;
      }
    }
  });
  return fenced;
}
