// Persists and lease-claims pre-execution action intents independently of task projection code.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type {
  GovernorTrustedReceiptResolver,
  HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  acknowledgeGovernorActionTermination,
  beginGovernorActionEffect,
  type GovernorActionTerminationResult,
  type GovernorBeginActionEffectResult,
} from "./action-execution-lifecycle.js";
import {
  actionIntentDb as dbx,
  bindGovernorActionIntent,
  parseGovernorActionIntent,
} from "./action-intent-codec.js";
import type { GovernorActionIntent, GovernorActionTerminationOutcome } from "./action-intent.js";
import { GovernorApprovalGrantStore } from "./approval-store.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import { loadGovernorTask } from "./store-queries.js";
import type { GovernorIdentityContext, GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorActionIntentUpdate = {
  current: GovernorActionIntent;
  next: GovernorActionIntent;
};

export type GovernorActionIntentClaimResult =
  | { kind: "claimed"; intent: GovernorActionIntent }
  | { kind: "reconcile_required"; intent: GovernorActionIntent }
  | {
      kind:
        | "busy"
        | "stale_worker"
        | "not_found"
        | "completed"
        | "approval_required"
        | "approval_stale"
        | "approval_revoked";
    };

export type GovernorActionOutcomeValidation =
  | { kind: "ready"; task: GovernorTaskProjection; intent: GovernorActionIntent }
  | { kind: "stale_worker" | "approval_required" | "approval_stale" | "approval_revoked" };

export class GovernorActionIntentStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #approvals: GovernorApprovalGrantStore;
  readonly #capabilities: GovernorCapabilityRegistry;
  readonly #identity: GovernorIdentityContext;
  readonly #receipts: GovernorTrustedReceiptResolver;

  constructor(params: {
    stateDir?: string;
    options?: OpenClawStateDatabaseOptions;
    approvals: GovernorApprovalGrantStore;
    capabilities: GovernorCapabilityRegistry;
    identity: GovernorIdentityContext;
    receiptResolver: GovernorTrustedReceiptResolver;
  }) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    this.#approvals = params.approvals;
    this.#capabilities = params.capabilities;
    this.#identity = params.identity;
    this.#receipts = params.receiptResolver;
    initializeGovernorStateSchema(this.#options);
  }

  load(taskId: GovernorTaskId, effectId: string): GovernorActionIntent | null {
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_action_intents")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("effect_id", "=", effectId),
    );
    return row ? parseGovernorActionIntent(row) : null;
  }

  listPendingIds(taskId: GovernorTaskId, objectiveRevision: number): string[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_action_intents")
        .select(["effect_id"])
        .where("task_id", "=", taskId)
        .where("objective_revision", "=", objectiveRevision)
        .where((eb) =>
          eb.or([
            eb("state", "in", ["admitted", "running"]),
            eb("termination_outcome", "=", "unknown"),
          ]),
        )
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map((row) => row.effect_id);
  }

  beginEffect(params: {
    taskId: GovernorTaskId;
    effectId: string;
    workerId: string;
    claimEpoch: number;
    objectiveRevision: number;
    planVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    now: number;
  }): GovernorBeginActionEffectResult {
    return beginGovernorActionEffect(
      {
        options: this.#options,
        approvals: this.#approvals,
        capabilities: this.#capabilities,
        identity: this.#identity,
        receipts: this.#receipts,
      },
      params,
    );
  }

  acknowledgeTermination(params: {
    taskId: GovernorTaskId;
    effectId: string;
    receiptId: HostGovernorReceiptId;
    outcome: GovernorActionTerminationOutcome;
    now: number;
  }): GovernorActionTerminationResult {
    return acknowledgeGovernorActionTermination(
      {
        options: this.#options,
        approvals: this.#approvals,
        capabilities: this.#capabilities,
        identity: this.#identity,
        receipts: this.#receipts,
      },
      params,
    );
  }

  /**
   * Revalidates the worker claim while holding the state write lock immediately
   * before an outcome can be persisted. Revocation fences an expired intent by
   * updating the same row, so a concurrent outcome commit cannot win on an old
   * updated_at/claim_epoch pair.
   */
  validateOutcome(params: {
    taskId: GovernorTaskId;
    effectId: string;
    workerId: string;
    claimEpoch: number;
    objectiveRevision: number;
    planVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    now: number;
  }): GovernorActionOutcomeValidation {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = loadGovernorTask(db, params.taskId);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_action_intents")
          .selectAll()
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId),
      );
      if (!task || !row) {
        return { kind: "stale_worker" };
      }
      const intent = parseGovernorActionIntent(row);
      if (
        task.state !== "EXECUTING" ||
        task.objectiveRevision !== params.objectiveRevision ||
        task.planVersion !== params.planVersion ||
        task.leaseEpoch !== params.leaseEpoch ||
        task.executionGeneration !== params.executionGeneration ||
        intent.state !== "running" ||
        intent.claimedBy !== params.workerId ||
        intent.claimEpoch !== params.claimEpoch ||
        intent.objectiveRevision !== params.objectiveRevision ||
        intent.planVersion !== params.planVersion ||
        intent.leaseEpoch !== params.leaseEpoch ||
        intent.executionGeneration !== params.executionGeneration ||
        intent.leaseExpiresAt === undefined ||
        intent.leaseExpiresAt <= params.now ||
        intent.effectStartedAt === undefined ||
        intent.cancellationRequestedAt !== undefined ||
        intent.terminationOutcome !== undefined
      ) {
        return { kind: "stale_worker" };
      }
      try {
        this.#capabilities.assertPersistedIntentAuthorized(task, intent.proposal, this.#identity);
      } catch {
        return { kind: "stale_worker" };
      }
      const approvalPolicy = this.#capabilities.approvalPolicy(intent.proposal);
      if (
        intent.approvalRequired !== approvalPolicy.required ||
        intent.approvalPolicyDigest !== approvalPolicy.digest
      ) {
        return { kind: "stale_worker" };
      }
      if (intent.approvalRequired) {
        if (!intent.proposal.approvalGrantId) {
          return { kind: "approval_required" };
        }
        const approval = this.#approvals.statusWithinTransaction(
          db,
          {
            taskId: intent.taskId,
            scopeKey: task.scopeKey,
            objectiveRevision: params.objectiveRevision,
          },
          intent.proposal,
          params.now,
        );
        if (approval !== "approved") {
          return {
            kind:
              approval === "missing"
                ? "approval_required"
                : approval === "stale"
                  ? "approval_stale"
                  : "approval_revoked",
          };
        }
      }
      return { kind: "ready", task, intent };
    }, this.#options);
  }

  claim(params: {
    taskId: GovernorTaskId;
    effectId: string;
    objectiveRevision: number;
    planVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    workerId: string;
    leaseDurationMs?: number;
    now: number;
  }): GovernorActionIntentClaimResult {
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("Governor action workerId must not be empty");
    }
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor action leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = loadGovernorTask(db, params.taskId);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_action_intents")
          .selectAll()
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId),
      );
      if (!task || !row) {
        return { kind: "not_found" };
      }
      const intent = parseGovernorActionIntent(row);
      if (intent.state === "completed") {
        return { kind: "completed" };
      }
      if (
        task.state !== "EXECUTING" ||
        task.objectiveRevision !== params.objectiveRevision ||
        task.planVersion !== params.planVersion ||
        task.leaseEpoch !== params.leaseEpoch ||
        task.executionGeneration !== params.executionGeneration ||
        intent.objectiveRevision !== params.objectiveRevision ||
        intent.planVersion !== params.planVersion ||
        intent.leaseEpoch !== params.leaseEpoch ||
        intent.executionGeneration !== params.executionGeneration ||
        intent.state === "cancelled"
      ) {
        return { kind: "stale_worker" };
      }
      try {
        this.#capabilities.assertPersistedIntentAuthorized(task, intent.proposal, this.#identity);
      } catch {
        return { kind: "stale_worker" };
      }
      const approvalPolicy = this.#capabilities.approvalPolicy(intent.proposal);
      if (
        intent.approvalRequired !== approvalPolicy.required ||
        intent.approvalPolicyDigest !== approvalPolicy.digest
      ) {
        return { kind: "stale_worker" };
      }
      if (intent.approvalRequired) {
        if (!intent.proposal.approvalGrantId) {
          return { kind: "approval_required" };
        }
        const approval = this.#approvals.statusWithinTransaction(
          db,
          {
            taskId: intent.taskId,
            scopeKey: task.scopeKey,
            objectiveRevision: params.objectiveRevision,
          },
          intent.proposal,
          params.now,
        );
        if (approval !== "approved") {
          return {
            kind:
              approval === "missing"
                ? "approval_required"
                : approval === "stale"
                  ? "approval_stale"
                  : "approval_revoked",
          };
        }
      }
      if (intent.state === "running" && intent.effectStartedAt !== undefined) {
        if (
          intent.leaseExpiresAt !== undefined &&
          intent.leaseExpiresAt <= params.now &&
          intent.cancellationRequestedAt === undefined
        ) {
          const cancelling = {
            ...intent,
            cancellationRequestedAt: params.now,
            updatedAt: params.now,
          };
          const update = executeSqliteQuerySync(
            db,
            dbx(db)
              .updateTable("governor_action_intents")
              .set(bindGovernorActionIntent(cancelling))
              .where("task_id", "=", intent.taskId)
              .where("effect_id", "=", intent.effectId)
              .where("claim_epoch", "=", intent.claimEpoch)
              .where("updated_at", "=", intent.updatedAt),
          );
          return update.numAffectedRows === 1n
            ? { kind: "reconcile_required", intent: cancelling }
            : { kind: "busy" };
        }
        return intent.cancellationRequestedAt !== undefined || intent.claimedBy === workerId
          ? { kind: "reconcile_required", intent }
          : { kind: "busy" };
      }
      if (intent.state === "running" && intent.cancellationRequestedAt !== undefined) {
        return { kind: "stale_worker" };
      }
      if (
        intent.state === "running" &&
        intent.leaseExpiresAt !== undefined &&
        intent.leaseExpiresAt > params.now
      ) {
        return intent.claimedBy === workerId ? { kind: "claimed", intent } : { kind: "busy" };
      }
      const claimed: GovernorActionIntent = {
        ...intent,
        state: "running",
        claimEpoch: intent.claimEpoch + 1,
        claimedBy: workerId,
        leaseExpiresAt: params.now + leaseDurationMs,
        updatedAt: params.now,
      };
      const update = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_action_intents")
          .set(bindGovernorActionIntent(claimed))
          .where("task_id", "=", intent.taskId)
          .where("effect_id", "=", intent.effectId)
          .where("claim_epoch", "=", intent.claimEpoch)
          .where("updated_at", "=", intent.updatedAt),
      );
      return update.numAffectedRows === 1n
        ? { kind: "claimed", intent: claimed }
        : { kind: "busy" };
    }, this.#options);
  }
}
