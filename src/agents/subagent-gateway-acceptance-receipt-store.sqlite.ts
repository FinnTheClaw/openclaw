import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

type ReceiptRow = Selectable<DB["subagent_gateway_acceptance_receipts"]>;
type ReceiptDb = Pick<DB, "subagent_gateway_acceptance_receipts">;

export type GatewayAcceptanceReceipt = {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  lifecycle: "preaccepted" | "accepted" | "not_accepted" | "cancelled";
  receiptGeneration: number;
  acceptedAt?: number;
};

function fromRow(row: ReceiptRow): GatewayAcceptanceReceipt {
  return {
    acceptanceKey: row.acceptance_key,
    intentId: row.intent_id,
    controllerSessionKey: row.controller_session_key,
    requestDigest: row.request_digest,
    resolvedDigest: row.resolved_digest,
    gatewayRunId: row.gateway_run_id,
    childSessionKey: row.child_session_key,
    lifecycle: row.lifecycle as GatewayAcceptanceReceipt["lifecycle"],
    receiptGeneration: row.receipt_generation,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
  };
}

export function readGatewayAcceptanceReceipt(
  acceptanceKey: string,
): GatewayAcceptanceReceipt | undefined {
  let result: GatewayAcceptanceReceipt | undefined;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_gateway_acceptance_receipts")
        .selectAll()
        .where("acceptance_key", "=", acceptanceKey),
    ).rows[0];
    result = row ? fromRow(row) : undefined;
  });
  return result;
}

/** Commits the gateway acceptance before the accepted response is emitted. */
export function reserveGatewayAcceptanceReceipt(params: {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  now?: number;
}): GatewayAcceptanceReceipt {
  let receipt!: GatewayAcceptanceReceipt;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const existing = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_gateway_acceptance_receipts")
        .selectAll()
        .where("acceptance_key", "=", params.acceptanceKey),
    ).rows[0];
    if (existing) {
      const current = fromRow(existing);
      if (
        current.requestDigest !== params.requestDigest ||
        current.intentId !== params.intentId ||
        current.controllerSessionKey !== params.controllerSessionKey ||
        current.resolvedDigest !== params.resolvedDigest ||
        current.childSessionKey !== params.childSessionKey
      ) {
        throw new Error("gateway acceptance key conflicts with a different child request");
      }
      if (current.lifecycle === "not_accepted") {
        const now = params.now ?? Date.now();
        const nextGeneration = current.receiptGeneration + 1;
        const updated = executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("subagent_gateway_acceptance_receipts")
            .set({
              lifecycle: "preaccepted",
              gateway_run_id: params.gatewayRunId,
              receipt_generation: nextGeneration,
              accepted_at: now,
              updated_at: now,
            })
            .where("acceptance_key", "=", params.acceptanceKey)
            .where("receipt_generation", "=", current.receiptGeneration)
            .where("lifecycle", "=", "not_accepted"),
        );
        if (Number(updated.numAffectedRows ?? 0) !== 1) {
          throw new Error("gateway acceptance retry lost its durable CAS");
        }
        receipt = {
          ...current,
          gatewayRunId: params.gatewayRunId,
          lifecycle: "preaccepted",
          receiptGeneration: nextGeneration,
          acceptedAt: now,
        };
        return;
      }
      if (current.gatewayRunId !== params.gatewayRunId) {
        throw new Error("gateway acceptance key conflicts with an active attempt");
      }
      receipt = current;
      return;
    }
    const now = params.now ?? Date.now();
    const row = {
      acceptance_key: params.acceptanceKey,
      intent_id: params.intentId,
      controller_session_key: params.controllerSessionKey,
      request_digest: params.requestDigest,
      resolved_digest: params.resolvedDigest,
      gateway_run_id: params.gatewayRunId,
      child_session_key: params.childSessionKey,
      lifecycle: "preaccepted",
      receipt_generation: 0,
      accepted_at: now,
      updated_at: now,
      payload_json: "{}",
    };
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("subagent_gateway_acceptance_receipts").values(row),
    );
    receipt = fromRow(row as ReceiptRow);
  });
  return receipt;
}

/** Moves a pre-accepted receipt to accepted only after the runner is admitted. */
export function markGatewayAcceptanceAccepted(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const result = executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("subagent_gateway_acceptance_receipts")
        .set({ lifecycle: "accepted", updated_at: Date.now() })
        .where("acceptance_key", "=", params.acceptanceKey)
        .where("gateway_run_id", "=", params.gatewayRunId)
        .where("lifecycle", "=", "preaccepted"),
    );
    changed = Number(result.numAffectedRows ?? 0) === 1;
  });
  return changed;
}

export function markGatewayAcceptanceNotAccepted(params: {
  acceptanceKey: string;
  gatewayRunId: string;
}): boolean {
  let changed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ReceiptDb>(db);
    const result = executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("subagent_gateway_acceptance_receipts")
        .set({ lifecycle: "not_accepted", updated_at: Date.now() })
        .where("acceptance_key", "=", params.acceptanceKey)
        .where("gateway_run_id", "=", params.gatewayRunId)
        .where("lifecycle", "in", ["preaccepted", "accepted"]),
    );
    changed = Number(result.numAffectedRows ?? 0) === 1;
  });
  return changed;
}
