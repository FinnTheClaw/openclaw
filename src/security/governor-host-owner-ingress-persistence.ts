/** Durable opaque owner-ingress receipts owned by the private host boundary. */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as StateDb } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  GovernorOwnerIngressReceipt,
  HostGovernorOwnerIngressReceiptId,
} from "./governor-host-contracts.js";

type OwnerIngressDb = Pick<StateDb, "governor_owner_ingress_receipts">;
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<OwnerIngressDb>(db);

export type GovernorOwnerIngressPersistence = Readonly<{
  storeOwnerIngress: (receipt: GovernorOwnerIngressReceipt) => void;
  loadOwnerIngress: (
    receiptId: HostGovernorOwnerIngressReceiptId,
  ) => GovernorOwnerIngressReceipt | null;
  markOwnerIngressConsumed: (
    receiptId: HostGovernorOwnerIngressReceiptId,
    consumedAt: number,
  ) => boolean;
}>;

export function createGovernorOwnerIngressPersistence(
  options: OpenClawStateDatabaseOptions,
): GovernorOwnerIngressPersistence {
  return Object.freeze({
    storeOwnerIngress: (receipt) => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_owner_ingress_receipts")
            .selectAll()
            .where("nonce_ref", "=", receipt.nonceIdentity),
        );
        if (existing && existing.receipt_id !== receipt.id) {
          throw new Error("Governor owner ingress nonce was replayed");
        }
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_owner_ingress_receipts")
            .values({
              receipt_id: receipt.id,
              channel_ref: receipt.channel,
              account_ref: receipt.accountIdentity,
              gateway_ref: receipt.gatewayIdentity,
              owner_principal_ref: receipt.ownerPrincipalIdentity,
              source_message_ref: receipt.sourceMessageIdentity,
              source_sequence: receipt.sourceSequence,
              action: receipt.action,
              scope_key: receipt.scopeKey,
              nonce_ref: receipt.nonceIdentity,
              observed_at: receipt.observedAt,
              expires_at: receipt.expiresAt,
              deployment_ref: receipt.deploymentIdentity,
              signature: receipt.signature,
              consumed_at: receipt.consumedAt ?? null,
            })
            .onConflict((conflict) => conflict.column("receipt_id").doNothing()),
        );
      }, options);
    },
    loadOwnerIngress: (receiptId) => {
      const { db } = openOpenClawStateDatabase(options);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_owner_ingress_receipts")
          .selectAll()
          .where("receipt_id", "=", receiptId),
      );
      if (!row) {
        return null;
      }
      return {
        id: row.receipt_id as HostGovernorOwnerIngressReceiptId,
        channel: row.channel_ref as GovernorOwnerIngressReceipt["channel"],
        accountIdentity: row.account_ref,
        gatewayIdentity: row.gateway_ref,
        ownerPrincipalIdentity: row.owner_principal_ref,
        sourceMessageIdentity: row.source_message_ref,
        sourceSequence: normalizeSqliteNumber(row.source_sequence) ?? -1,
        action: row.action as GovernorOwnerIngressReceipt["action"],
        scopeKey: row.scope_key,
        nonceIdentity: row.nonce_ref,
        observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
        expiresAt: normalizeSqliteNumber(row.expires_at) ?? 0,
        deploymentIdentity: row.deployment_ref,
        ...(row.consumed_at == null
          ? {}
          : { consumedAt: normalizeSqliteNumber(row.consumed_at) ?? 0 }),
        signature: row.signature,
      };
    },
    markOwnerIngressConsumed: (receiptId, consumedAt) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_owner_ingress_receipts")
            .set({ consumed_at: consumedAt })
            .where("receipt_id", "=", receiptId)
            .where("consumed_at", "is", null),
        );
        if (update.numAffectedRows === 1n) {
          return true;
        }
        return Boolean(
          executeSqliteQueryTakeFirstSync(
            db,
            dbx(db)
              .selectFrom("governor_owner_ingress_receipts")
              .select("receipt_id")
              .where("receipt_id", "=", receiptId),
          ),
        );
      }, options),
  });
}
