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
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedJson } from "../tasks/governor/persistence-guard.js";
import type { GovernorHostAntiRollbackLedger } from "./governor-host-anti-rollback-ledger.js";
import type {
  GovernorOwnerIngressReceipt,
  HostGovernorOwnerIngressClaimToken,
  HostGovernorOwnerIngressReceiptId,
} from "./governor-host-contracts.js";

type OwnerIngressDb = Pick<StateDb, "governor_owner_ingress_receipts">;
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<OwnerIngressDb>(db);
const OPAQUE_HOST_REFERENCE = /^ghr_[a-f0-9]{64}$/u;

function assertOpaqueHostReference(value: string): void {
  if (!OPAQUE_HOST_REFERENCE.test(value)) {
    throw new Error("Governor owner ingress reference is invalid");
  }
}

function claimedBinding(receipt: GovernorOwnerIngressReceipt): string {
  return governorDigest({
    kind: "owner_ingress_claim",
    sourceBindingIdentity: receipt.sourceBindingIdentity,
    receiptId: receipt.id,
    sourceSequence: receipt.sourceSequence,
  });
}

function terminalBinding(
  receipt: GovernorOwnerIngressReceipt,
  status: "consumed" | "revoked",
  taskId?: string,
): string {
  return governorDigest({
    kind: `owner_ingress_${status}`,
    sourceBindingIdentity: receipt.sourceBindingIdentity,
    receiptId: receipt.id,
    sourceSequence: receipt.sourceSequence,
    ...(taskId ? { taskId } : {}),
  });
}

export type GovernorOwnerIngressPersistence = Readonly<{
  storeOwnerIngress: (receipt: GovernorOwnerIngressReceipt) => void;
  loadOwnerIngress: (
    receiptId: HostGovernorOwnerIngressReceiptId,
  ) => GovernorOwnerIngressReceipt | null;
  claimOwnerIngress: (input: {
    receipt: GovernorOwnerIngressReceipt;
    claimToken: HostGovernorOwnerIngressClaimToken;
    claimAttemptIdentity: string;
    now: number;
    leaseExpiresAt: number;
  }) => boolean;
  finalizeOwnerIngress: (input: {
    receipt: GovernorOwnerIngressReceipt;
    claimToken: HostGovernorOwnerIngressClaimToken;
    taskId: string;
    consumedAt: number;
  }) => boolean;
  revokeOwnerIngress: (input: {
    receipt: GovernorOwnerIngressReceipt;
    revokedAt: number;
  }) => boolean;
}>;

function parseReceipt(
  row: StateDb["governor_owner_ingress_receipts"],
): GovernorOwnerIngressReceipt {
  return {
    id: row.receipt_id as HostGovernorOwnerIngressReceiptId,
    channel: row.channel_ref as GovernorOwnerIngressReceipt["channel"],
    accountIdentity: row.account_ref,
    gatewayIdentity: row.gateway_ref,
    ownerPrincipalIdentity: row.owner_principal_ref,
    sourceMessageIdentity: row.source_message_ref,
    sourceBindingIdentity: row.source_binding_ref,
    sourceSequence: normalizeSqliteNumber(row.source_sequence) ?? -1,
    action: row.action as GovernorOwnerIngressReceipt["action"],
    scopeKey: row.scope_key,
    nonceIdentity: row.nonce_ref,
    observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
    expiresAt: normalizeSqliteNumber(row.expires_at) ?? 0,
    deploymentIdentity: row.deployment_ref,
    ...(row.consumed_at == null ? {} : { consumedAt: normalizeSqliteNumber(row.consumed_at) ?? 0 }),
    signature: row.signature,
  };
}

export function createGovernorOwnerIngressPersistence(
  options: OpenClawStateDatabaseOptions,
  ledger: GovernorHostAntiRollbackLedger,
): GovernorOwnerIngressPersistence {
  return Object.freeze({
    storeOwnerIngress: (receipt) => {
      assertGovernorPersistedJson("log", receipt);
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
              source_binding_ref: receipt.sourceBindingIdentity,
              source_sequence: receipt.sourceSequence,
              action: receipt.action,
              scope_key: receipt.scopeKey,
              nonce_ref: receipt.nonceIdentity,
              observed_at: receipt.observedAt,
              expires_at: receipt.expiresAt,
              deployment_ref: receipt.deploymentIdentity,
              signature: receipt.signature,
              claim_token_ref: null,
              claim_attempt_ref: null,
              claimed_at: null,
              claim_expires_at: null,
              ingested_task_id: null,
              revoked_at: null,
              consumed_at: receipt.consumedAt ?? null,
            })
            .onConflict((conflict) => conflict.column("receipt_id").doNothing()),
        );
      }, options);
    },
    loadOwnerIngress: (receiptId) => {
      assertGovernorPersistedJson("log", { receiptId });
      const row = runOpenClawStateWriteTransaction(
        ({ db }) =>
          executeSqliteQueryTakeFirstSync(
            db,
            dbx(db)
              .selectFrom("governor_owner_ingress_receipts")
              .selectAll()
              .where("receipt_id", "=", receiptId),
          ) ?? null,
        options,
      );
      return row ? parseReceipt(row) : null;
    },
    claimOwnerIngress: (input) => {
      assertOpaqueHostReference(input.claimToken);
      assertGovernorPersistedJson("log", {
        receipt: input.receipt,
        opaqueClaimReference: input.claimToken,
        claimAttemptIdentity: input.claimAttemptIdentity,
        now: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      return runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_owner_ingress_receipts")
            .selectAll()
            .where("receipt_id", "=", input.receipt.id),
        );
        if (
          !row ||
          row.signature !== input.receipt.signature ||
          row.source_binding_ref !== input.receipt.sourceBindingIdentity ||
          row.consumed_at != null ||
          row.revoked_at != null ||
          (normalizeSqliteNumber(row.expires_at) ?? 0) <= input.now
        ) {
          return false;
        }
        const current = ledger.state("ingress", input.receipt.sourceBindingIdentity);
        const expectedBinding = claimedBinding(input.receipt);
        const recoveringConsumed =
          current?.generation === input.receipt.sourceSequence &&
          current.status === "consumed" &&
          row.ingested_task_id != null &&
          current.bindingDigest ===
            terminalBinding(input.receipt, "consumed", row.ingested_task_id);
        if (
          current &&
          (current.generation > input.receipt.sourceSequence ||
            (current.generation === input.receipt.sourceSequence &&
              !recoveringConsumed &&
              (current.status !== "claimed" || current.bindingDigest !== expectedBinding)))
        ) {
          return false;
        }
        const currentLease = normalizeSqliteNumber(row.claim_expires_at);
        if (
          row.claim_token_ref &&
          row.claim_token_ref !== input.claimToken &&
          currentLease != null &&
          currentLease > input.now
        ) {
          return false;
        }
        if (!current || current.generation < input.receipt.sourceSequence) {
          ledger.append({
            kind: "ingress",
            key: input.receipt.sourceBindingIdentity,
            generation: input.receipt.sourceSequence,
            status: "claimed",
            bindingDigest: expectedBinding,
          });
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_owner_ingress_receipts")
            .set({
              claim_token_ref: input.claimToken,
              claim_attempt_ref: input.claimAttemptIdentity,
              claimed_at: input.now,
              claim_expires_at: input.leaseExpiresAt,
            })
            .where("receipt_id", "=", input.receipt.id)
            .where("consumed_at", "is", null)
            .where("revoked_at", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options);
    },
    finalizeOwnerIngress: (input) => {
      assertOpaqueHostReference(input.claimToken);
      assertGovernorPersistedJson("log", {
        receipt: input.receipt,
        opaqueClaimReference: input.claimToken,
        taskId: input.taskId,
        consumedAt: input.consumedAt,
      });
      const prepared = runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_owner_ingress_receipts")
            .selectAll()
            .where("receipt_id", "=", input.receipt.id),
        );
        if (
          !row ||
          row.revoked_at != null ||
          row.claim_token_ref !== input.claimToken ||
          (row.ingested_task_id != null && row.ingested_task_id !== input.taskId)
        ) {
          return false;
        }
        if (row.consumed_at != null) {
          return row.ingested_task_id === input.taskId;
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_owner_ingress_receipts")
            .set({ ingested_task_id: input.taskId })
            .where("receipt_id", "=", input.receipt.id)
            .where("claim_token_ref", "=", input.claimToken)
            .where("consumed_at", "is", null)
            .where("revoked_at", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options);
      if (!prepared) {
        return false;
      }
      return runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_owner_ingress_receipts")
            .selectAll()
            .where("receipt_id", "=", input.receipt.id),
        );
        if (
          !row ||
          row.revoked_at != null ||
          row.claim_token_ref !== input.claimToken ||
          row.ingested_task_id !== input.taskId
        ) {
          return false;
        }
        if (row.consumed_at != null) {
          return true;
        }
        const current = ledger.state("ingress", input.receipt.sourceBindingIdentity);
        const consumed = terminalBinding(input.receipt, "consumed", input.taskId);
        if (
          !current ||
          current.generation < input.receipt.sourceSequence ||
          (current.generation === input.receipt.sourceSequence &&
            current.status !== "claimed" &&
            !(current.status === "consumed" && current.bindingDigest === consumed))
        ) {
          return false;
        }
        if (current.generation === input.receipt.sourceSequence && current.status === "claimed") {
          ledger.append({
            kind: "ingress",
            key: input.receipt.sourceBindingIdentity,
            generation: input.receipt.sourceSequence,
            status: "consumed",
            bindingDigest: consumed,
          });
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_owner_ingress_receipts")
            .set({ ingested_task_id: input.taskId, consumed_at: input.consumedAt })
            .where("receipt_id", "=", input.receipt.id)
            .where("claim_token_ref", "=", input.claimToken)
            .where("consumed_at", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options);
    },
    revokeOwnerIngress: (input) => {
      assertGovernorPersistedJson("log", input);
      return runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_owner_ingress_receipts")
            .selectAll()
            .where("receipt_id", "=", input.receipt.id),
        );
        if (!row || row.consumed_at != null || row.ingested_task_id != null) {
          return false;
        }
        const current = ledger.state("ingress", input.receipt.sourceBindingIdentity);
        if (!current || current.generation <= input.receipt.sourceSequence) {
          const binding = terminalBinding(input.receipt, "revoked");
          if (
            !current ||
            current.generation < input.receipt.sourceSequence ||
            current.status === "claimed" ||
            (current.status === "revoked" && current.bindingDigest === binding)
          ) {
            ledger.append({
              kind: "ingress",
              key: input.receipt.sourceBindingIdentity,
              generation: input.receipt.sourceSequence,
              status: "revoked",
              bindingDigest: binding,
            });
          } else {
            return false;
          }
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_owner_ingress_receipts")
            .set({
              revoked_at: input.revokedAt,
              claim_token_ref: null,
              claim_attempt_ref: null,
              claim_expires_at: null,
            })
            .where("receipt_id", "=", input.receipt.id)
            .where("consumed_at", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options);
    },
  });
}
