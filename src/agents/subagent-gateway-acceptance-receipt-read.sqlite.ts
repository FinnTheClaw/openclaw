import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  type GatewayAcceptanceReceiptEnvelope,
  type GatewayAcceptanceReceiptProof,
  verifyGatewayAcceptanceReceiptProof,
} from "./subagent-gateway-acceptance-receipt-auth.js";
import type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";

export type ReceiptRow = Selectable<DB["subagent_gateway_acceptance_receipts"]>;
export type ReceiptDb = Pick<DB, "subagent_gateway_acceptance_receipts" | "subagent_child_intents">;

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

export function fromRow(row: ReceiptRow): GatewayAcceptanceReceipt {
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

export function readRow(database: DatabaseSync, acceptanceKey: string): ReceiptRow | undefined {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ReceiptDb>(database)
      .selectFrom("subagent_gateway_acceptance_receipts")
      .selectAll()
      .where("acceptance_key", "=", acceptanceKey),
  ).rows[0];
}

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

export function readGatewayAcceptanceReceipt(
  acceptanceKey: string,
): GatewayAcceptanceReceipt | undefined {
  let result: GatewayAcceptanceReceipt | undefined;
  runOpenClawStateWriteTransaction(({ db }) => {
    result = readGatewayAcceptanceReceiptFromDatabase(db, acceptanceKey);
  });
  return result;
}
