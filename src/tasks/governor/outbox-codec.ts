// Encodes the durable governor outbox independently from its delivery lifecycle.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorTaskId } from "./types.js";

type OutboxDatabase = Pick<OpenClawStateKyselyDatabase, "governor_tasks" | "governor_outbox">;
type GovernorOutboxRow = Selectable<OpenClawStateKyselyDatabase["governor_outbox"]>;

export type GovernorOutboxState = "pending" | "claimed" | "sent" | "would_send" | "manual_review";

export type GovernorOutboxDeliveryBinding = Readonly<{
  adapterHandle: string;
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  channel: string;
  accountIdentity: string;
  targetIdentity: string;
  deploymentIdentity: string;
}>;

export type GovernorOutboxRecord = {
  taskId: GovernorTaskId;
  effectId: string;
  deliveryKey: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  deliveryClaimEpoch: number;
  claimedBy?: string;
  leaseExpiresAt?: number;
  state: GovernorOutboxState;
  payload: GovernorJsonValue;
  providerReceipt?: GovernorJsonValue;
  claimedAt?: number;
  sentAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type GovernorOutboxClaimResult =
  | { kind: "claimed"; entry: GovernorOutboxRecord }
  | { kind: "not_found" | "stale_worker" | "obsolete" | "busy" }
  | { kind: "reconcile_required" | "manual_review" | "would_send"; entry: GovernorOutboxRecord }
  | { kind: "already_sent"; entry: GovernorOutboxRecord };

export function governorOutboxDb(db: DatabaseSync) {
  return getNodeSqliteKysely<OutboxDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid persisted governor ${label}`);
  }
}

export function bindGovernorOutbox(entry: GovernorOutboxRecord): Insertable<GovernorOutboxRow> {
  assertGovernorPersistedJson("log", entry);
  return {
    task_id: entry.taskId,
    effect_id: entry.effectId,
    delivery_key: entry.deliveryKey,
    task_version: entry.taskVersion,
    objective_revision: entry.objectiveRevision,
    plan_version: entry.planVersion,
    lease_epoch: entry.leaseEpoch,
    execution_generation: entry.executionGeneration,
    delivery_claim_epoch: entry.deliveryClaimEpoch,
    claimed_by: entry.claimedBy ?? null,
    lease_expires_at: entry.leaseExpiresAt ?? null,
    state: entry.state,
    payload_json: JSON.stringify(entry.payload),
    provider_receipt_json: entry.providerReceipt ? JSON.stringify(entry.providerReceipt) : null,
    claimed_at: entry.claimedAt ?? null,
    sent_at: entry.sentAt ?? null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

export function parseGovernorOutbox(row: GovernorOutboxRow): GovernorOutboxRecord {
  const entry: GovernorOutboxRecord = {
    taskId: row.task_id as GovernorTaskId,
    effectId: row.effect_id,
    deliveryKey: row.delivery_key,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    executionGeneration: normalizeSqliteNumber(row.execution_generation) ?? 0,
    deliveryClaimEpoch: normalizeSqliteNumber(row.delivery_claim_epoch) ?? 0,
    ...(row.claimed_by == null ? {} : { claimedBy: row.claimed_by }),
    ...(row.lease_expires_at == null
      ? {}
      : { leaseExpiresAt: normalizeSqliteNumber(row.lease_expires_at) ?? 0 }),
    state: row.state as GovernorOutboxState,
    payload: parseJson(row.payload_json, "outbox payload") as GovernorJsonValue,
    ...(row.provider_receipt_json
      ? {
          providerReceipt: parseJson(
            row.provider_receipt_json,
            "provider receipt",
          ) as GovernorJsonValue,
        }
      : {}),
    ...(row.claimed_at == null ? {} : { claimedAt: normalizeSqliteNumber(row.claimed_at) ?? 0 }),
    ...(row.sent_at == null ? {} : { sentAt: normalizeSqliteNumber(row.sent_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
  assertGovernorPersistedJson("log", entry);
  return entry;
}
