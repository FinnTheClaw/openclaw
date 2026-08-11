// Owns lease-fenced transactional reply delivery and stable provider idempotency keys.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

type OutboxDatabase = Pick<OpenClawStateKyselyDatabase, "governor_tasks" | "governor_outbox">;
type GovernorOutboxRow = Selectable<OpenClawStateKyselyDatabase["governor_outbox"]>;

export type GovernorOutboxState = "pending" | "claimed" | "sent";

export type GovernorOutboxRecord = {
  taskId: GovernorTaskId;
  effectId: string;
  deliveryKey: string;
  taskVersion: number;
  objectiveRevision: number;
  leaseEpoch: number;
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
  | { kind: "already_sent"; entry: GovernorOutboxRecord };

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<OutboxDatabase>(db);
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid persisted governor ${label}`, { cause: error });
  }
}

export function bindGovernorOutbox(entry: GovernorOutboxRecord): Insertable<GovernorOutboxRow> {
  return {
    task_id: entry.taskId,
    effect_id: entry.effectId,
    delivery_key: entry.deliveryKey,
    task_version: entry.taskVersion,
    objective_revision: entry.objectiveRevision,
    lease_epoch: entry.leaseEpoch,
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

function parseOutbox(row: GovernorOutboxRow): GovernorOutboxRecord {
  return {
    taskId: row.task_id as GovernorTaskId,
    effectId: row.effect_id,
    deliveryKey: row.delivery_key,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    deliveryClaimEpoch: normalizeSqliteNumber(row.delivery_claim_epoch) ?? 0,
    ...(row.claimed_by == null ? {} : { claimedBy: row.claimed_by }),
    ...(row.lease_expires_at == null
      ? {}
      : { leaseExpiresAt: normalizeSqliteNumber(row.lease_expires_at) ?? 0 }),
    state: row.state as GovernorOutboxState,
    payload: parseJson<GovernorJsonValue>(row.payload_json, "outbox payload"),
    ...(row.provider_receipt_json
      ? {
          providerReceipt: parseJson<GovernorJsonValue>(
            row.provider_receipt_json,
            "provider receipt",
          ),
        }
      : {}),
    ...(row.claimed_at == null ? {} : { claimedAt: normalizeSqliteNumber(row.claimed_at) ?? 0 }),
    ...(row.sent_at == null ? {} : { sentAt: normalizeSqliteNumber(row.sent_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

export class GovernorOutboxStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
  }

  list(taskId: GovernorTaskId): GovernorOutboxRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_outbox")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseOutbox);
  }

  claim(params: {
    taskId: GovernorTaskId;
    effectId: string;
    expectedLeaseEpoch: number;
    workerId: string;
    now: number;
    leaseDurationMs?: number;
  }): GovernorOutboxClaimResult {
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("Governor outbox workerId must not be empty");
    }
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor outbox leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_tasks")
          .select(["objective_revision", "lease_epoch"])
          .where("task_id", "=", params.taskId),
      );
      if (!task) {
        return { kind: "not_found" };
      }
      if (normalizeSqliteNumber(task.lease_epoch) !== params.expectedLeaseEpoch) {
        return { kind: "stale_worker" };
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_outbox")
          .selectAll()
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId),
      );
      if (!row) {
        return { kind: "not_found" };
      }
      const entry = parseOutbox(row);
      if (entry.objectiveRevision !== normalizeSqliteNumber(task.objective_revision)) {
        return { kind: "obsolete" };
      }
      if (entry.state === "sent") {
        return { kind: "already_sent", entry };
      }
      if (
        entry.state === "claimed" &&
        entry.leaseExpiresAt !== undefined &&
        entry.leaseExpiresAt > params.now
      ) {
        return { kind: "busy" };
      }
      const claimed: GovernorOutboxRecord = {
        ...entry,
        leaseEpoch: params.expectedLeaseEpoch,
        deliveryClaimEpoch: entry.deliveryClaimEpoch + 1,
        claimedBy: workerId,
        leaseExpiresAt: params.now + leaseDurationMs,
        state: "claimed",
        claimedAt: params.now,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_outbox")
          .set(bindGovernorOutbox(claimed))
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId)
          .where("state", "!=", "sent"),
      );
      return { kind: "claimed", entry: claimed };
    }, this.#options);
  }

  markSent(params: {
    taskId: GovernorTaskId;
    effectId: string;
    expectedLeaseEpoch: number;
    expectedDeliveryClaimEpoch: number;
    workerId: string;
    providerReceipt: GovernorJsonValue;
    now: number;
  }): GovernorOutboxClaimResult {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_tasks")
          .select(["objective_revision", "lease_epoch"])
          .where("task_id", "=", params.taskId),
      );
      if (!task) {
        return { kind: "not_found" };
      }
      if (normalizeSqliteNumber(task.lease_epoch) !== params.expectedLeaseEpoch) {
        return { kind: "stale_worker" };
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_outbox")
          .selectAll()
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId),
      );
      if (!row) {
        return { kind: "not_found" };
      }
      const entry = parseOutbox(row);
      if (entry.state === "sent") {
        return { kind: "already_sent", entry };
      }
      if (entry.objectiveRevision !== normalizeSqliteNumber(task.objective_revision)) {
        return { kind: "obsolete" };
      }
      if (
        entry.state !== "claimed" ||
        entry.deliveryClaimEpoch !== params.expectedDeliveryClaimEpoch ||
        entry.claimedBy !== params.workerId
      ) {
        return { kind: "stale_worker" };
      }
      const sent: GovernorOutboxRecord = {
        ...entry,
        state: "sent",
        providerReceipt: structuredClone(params.providerReceipt),
        sentAt: params.now,
        updatedAt: params.now,
      };
      delete sent.leaseExpiresAt;
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_outbox")
          .set(bindGovernorOutbox(sent))
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId)
          .where("state", "!=", "sent"),
      );
      return { kind: "claimed", entry: sent };
    }, this.#options);
  }

  createCompletion(params: {
    task: GovernorTaskProjection;
    effectId: string;
    payload: GovernorJsonValue;
    now: number;
  }): GovernorOutboxRecord {
    const payload = assertGovernorBoundarySafe("session", params.payload);
    return {
      taskId: params.task.taskId,
      effectId: params.effectId,
      deliveryKey: governorDigest({ taskId: params.task.taskId, effectId: params.effectId }),
      taskVersion: params.task.taskVersion,
      objectiveRevision: params.task.objectiveRevision,
      leaseEpoch: params.task.leaseEpoch,
      deliveryClaimEpoch: 0,
      state: "pending",
      payload,
      createdAt: params.now,
      updatedAt: params.now,
    };
  }
}
