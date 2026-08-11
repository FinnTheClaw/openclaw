// Owns lease-fenced transactional reply delivery and stable provider idempotency keys.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
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
import {
  bindGovernorOutbox,
  governorOutboxDb as dbx,
  parseGovernorOutbox as parseOutbox,
  type GovernorOutboxClaimResult,
  type GovernorOutboxDeliveryBinding,
  type GovernorOutboxRecord,
} from "./outbox-codec.js";
import { createGovernorOutboxCompletion } from "./outbox-completion.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export { bindGovernorOutbox } from "./outbox-codec.js";
export type {
  GovernorOutboxClaimResult,
  GovernorOutboxDeliveryBinding,
  GovernorOutboxRecord,
  GovernorOutboxState,
} from "./outbox-codec.js";

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
    assertGovernorPersistedJson("log", {
      taskId: params.taskId,
      effectId: params.effectId,
      expectedLeaseEpoch: params.expectedLeaseEpoch,
      workerId: params.workerId,
      now: params.now,
      leaseDurationMs: params.leaseDurationMs ?? null,
      deliveryBinding: params.deliveryBinding,
    });
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
    assertGovernorPersistedJson("log", {
      taskId: params.taskId,
      effectId: params.effectId,
      expectedLeaseEpoch: params.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: params.expectedDeliveryClaimEpoch,
      workerId: params.workerId,
      verifiedReceipt: params.verifiedReceipt.receipt,
      now: params.now,
      terminalState: params.terminalState ?? null,
    });
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
    assertGovernorPersistedJson("log", params);
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
    assertGovernorPersistedJson("log", params);
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
    return createGovernorOutboxCompletion(params);
  }
}
