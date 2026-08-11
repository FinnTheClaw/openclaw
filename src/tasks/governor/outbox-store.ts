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
import {
  isGovernorVerifiedDeliveryReceipt,
  type GovernorVerifiedDeliveryReceipt,
} from "./delivery-certification-store.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

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

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<OutboxDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
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

function parseOutbox(row: GovernorOutboxRow): GovernorOutboxRecord {
  return {
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
}

export class GovernorOutboxStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string; options?: OpenClawStateDatabaseOptions } = {}) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    initializeGovernorStateSchema(this.#options);
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
    deliveryBinding: GovernorOutboxDeliveryBinding;
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
          .select(["objective_revision", "plan_version", "lease_epoch", "execution_generation"])
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
      const safeBinding = assertGovernorBoundarySafe(
        "log",
        params.deliveryBinding as unknown as GovernorJsonValue,
      ) as unknown as GovernorOutboxDeliveryBinding;
      const payloadDigest = governorDigest(entry.payload);
      const bindingDigest = governorDigest(safeBinding as unknown as GovernorJsonValue);
      const deliveryKey = governorDigest({
        taskId: entry.taskId,
        effectId: entry.effectId,
        objectiveRevision: entry.objectiveRevision,
        planVersion: entry.planVersion,
        executionGeneration: entry.executionGeneration,
        payloadDigest,
        bindingDigest,
      });
      if (
        entry.objectiveRevision !== normalizeSqliteNumber(task.objective_revision) ||
        entry.planVersion !== normalizeSqliteNumber(task.plan_version) ||
        entry.executionGeneration !== normalizeSqliteNumber(task.execution_generation)
      ) {
        return { kind: "obsolete" };
      }
      if (entry.state === "sent") {
        return { kind: "already_sent", entry };
      }
      if (entry.state === "would_send") {
        return { kind: "would_send", entry };
      }
      if (entry.state === "manual_review") {
        return { kind: "manual_review", entry };
      }
      const priorBindingDigest =
        entry.providerReceipt &&
        !Array.isArray(entry.providerReceipt) &&
        typeof entry.providerReceipt === "object" &&
        typeof entry.providerReceipt.bindingDigest === "string"
          ? entry.providerReceipt.bindingDigest
          : undefined;
      if (
        entry.state === "claimed" &&
        (entry.deliveryKey !== deliveryKey || priorBindingDigest !== bindingDigest)
      ) {
        return { kind: "obsolete" };
      }
      if (
        entry.state === "claimed" &&
        entry.leaseExpiresAt !== undefined &&
        entry.leaseExpiresAt > params.now
      ) {
        return { kind: "busy" };
      }
      if (entry.state === "claimed") {
        return { kind: "reconcile_required", entry };
      }
      const claimed: GovernorOutboxRecord = {
        ...entry,
        deliveryKey,
        leaseEpoch: params.expectedLeaseEpoch,
        deliveryClaimEpoch: entry.deliveryClaimEpoch + 1,
        claimedBy: workerId,
        leaseExpiresAt: params.now + leaseDurationMs,
        state: "claimed",
        providerReceipt: { bindingDigest, payloadDigest },
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
    verifiedReceipt: GovernorVerifiedDeliveryReceipt;
    now: number;
    terminalState?: "sent" | "would_send";
  }): GovernorOutboxClaimResult {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_tasks")
          .select(["objective_revision", "plan_version", "lease_epoch", "execution_generation"])
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
      if (entry.state === "would_send") {
        return { kind: "would_send", entry };
      }
      if (
        entry.objectiveRevision !== normalizeSqliteNumber(task.objective_revision) ||
        entry.planVersion !== normalizeSqliteNumber(task.plan_version) ||
        entry.executionGeneration !== normalizeSqliteNumber(task.execution_generation)
      ) {
        return { kind: "obsolete" };
      }
      if (
        entry.state !== "claimed" ||
        entry.deliveryClaimEpoch !== params.expectedDeliveryClaimEpoch ||
        entry.claimedBy !== params.workerId
      ) {
        return { kind: "stale_worker" };
      }
      if (!isGovernorVerifiedDeliveryReceipt(params.verifiedReceipt)) {
        throw new Error("Governor outbox requires a verified host delivery receipt");
      }
      const terminalState = params.terminalState ?? "sent";
      const expectedPayloadDigest =
        entry.providerReceipt &&
        !Array.isArray(entry.providerReceipt) &&
        typeof entry.providerReceipt === "object" &&
        typeof entry.providerReceipt.payloadDigest === "string"
          ? entry.providerReceipt.payloadDigest
          : undefined;
      if (
        params.verifiedReceipt.receipt.deliveryKey !== entry.deliveryKey ||
        params.verifiedReceipt.receipt.payloadDigest !== expectedPayloadDigest ||
        params.verifiedReceipt.receipt.outcome !== terminalState
      ) {
        throw new Error("Governor delivery receipt binding is mismatched");
      }
      const safeProviderReceipt = assertGovernorBoundarySafe(
        "log",
        params.verifiedReceipt.receipt as unknown as GovernorJsonValue,
      );
      const providerReceipt = {
        ...(entry.providerReceipt &&
        !Array.isArray(entry.providerReceipt) &&
        typeof entry.providerReceipt === "object"
          ? entry.providerReceipt
          : {}),
        receiptDigest: governorDigest(safeProviderReceipt),
      } as const;
      const sent: GovernorOutboxRecord = {
        ...entry,
        state: terminalState,
        providerReceipt,
        ...(terminalState === "sent" ? { sentAt: params.now } : {}),
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
          .where("state", "=", "claimed"),
      );
      return terminalState === "would_send"
        ? { kind: "would_send", entry: sent }
        : { kind: "claimed", entry: sent };
    }, this.#options);
  }

  markWouldSend(params: {
    taskId: GovernorTaskId;
    effectId: string;
    expectedLeaseEpoch: number;
    expectedDeliveryClaimEpoch: number;
    workerId: string;
    verifiedReceipt: GovernorVerifiedDeliveryReceipt;
    now: number;
  }): GovernorOutboxClaimResult {
    return this.markSent({
      ...params,
      verifiedReceipt: params.verifiedReceipt,
      terminalState: "would_send",
    });
  }

  markManualReview(params: {
    taskId: GovernorTaskId;
    effectId: string;
    expectedLeaseEpoch: number;
    expectedDeliveryClaimEpoch: number;
    reasonDigest: string;
    now: number;
  }): GovernorOutboxClaimResult {
    if (!/^[a-f0-9]{64}$/u.test(params.reasonDigest)) {
      throw new Error("Governor manual-review reason must be a SHA-256 digest");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_tasks")
          .select(["objective_revision", "plan_version", "lease_epoch", "execution_generation"])
          .where("task_id", "=", params.taskId),
      );
      if (!task) {
        return { kind: "not_found" };
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
      if (
        normalizeSqliteNumber(task.lease_epoch) !== params.expectedLeaseEpoch ||
        entry.objectiveRevision !== normalizeSqliteNumber(task.objective_revision) ||
        entry.planVersion !== normalizeSqliteNumber(task.plan_version) ||
        entry.executionGeneration !== normalizeSqliteNumber(task.execution_generation)
      ) {
        return { kind: "stale_worker" };
      }
      if (
        entry.state !== "claimed" ||
        entry.leaseEpoch !== params.expectedLeaseEpoch ||
        entry.deliveryClaimEpoch !== params.expectedDeliveryClaimEpoch
      ) {
        return entry.state === "manual_review"
          ? { kind: "manual_review", entry }
          : { kind: "stale_worker" };
      }
      const providerReceipt = {
        ...(entry.providerReceipt &&
        !Array.isArray(entry.providerReceipt) &&
        typeof entry.providerReceipt === "object"
          ? entry.providerReceipt
          : {}),
        unknownOutcomeDigest: params.reasonDigest,
      } as GovernorJsonValue;
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_outbox")
          .set({
            state: "manual_review",
            provider_receipt_json: JSON.stringify(providerReceipt),
            lease_expires_at: null,
            updated_at: params.now,
          })
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId)
          .where("state", "=", "claimed"),
      );
      return {
        kind: "manual_review",
        entry: { ...entry, state: "manual_review", providerReceipt, updatedAt: params.now },
      };
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
      planVersion: params.task.planVersion,
      leaseEpoch: params.task.leaseEpoch,
      executionGeneration: params.task.executionGeneration,
      deliveryClaimEpoch: 0,
      state: "pending",
      payload,
      createdAt: params.now,
      updatedAt: params.now,
    };
  }
}
