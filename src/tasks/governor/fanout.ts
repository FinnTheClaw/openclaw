// Provides a durable FIFO subagent queue, three-slot admission, and CAS-fenced structured fan-in.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  isTrustedGovernorPhysicalExecutionCoordinator,
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedPhysicalExecutionCoordinator,
  type GovernorTrustedReceiptResolver,
  type HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  GovernorFaninReducerStore,
  type GovernorClaimReducerParams,
  type GovernorCompleteReducerParams,
} from "./fanin-reducer-store.js";
import {
  bindJob,
  fanoutDb,
  parseJob,
  parseTaskProjection,
  type GovernorFanoutClaim,
  type GovernorFanoutCompletion,
  type GovernorFanoutJob,
  type GovernorReducerClaim,
} from "./fanout-codec.js";
import { completeFanoutJob } from "./fanout-completion.js";
import {
  acknowledgeFanoutTermination,
  acknowledgeOrphanedFanoutTermination,
  cancelFanoutJob,
  heartbeatFanoutJob,
} from "./fanout-lifecycle.js";
import {
  fanoutPhysicalBinding,
  reconcileFanoutPhysicalState,
  requestFanoutCancellation,
} from "./fanout-physical.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type {
  GovernorFaninEnvelope,
  GovernorFanoutClaim,
  GovernorFanoutCompletion,
  GovernorFanoutJob,
  GovernorFanoutJobState,
  GovernorReducerClaim,
} from "./fanout-codec.js";

export const MAX_GOVERNOR_PHYSICAL_EXECUTIONS = 3;

export class GovernorFanoutStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #physical: GovernorTrustedPhysicalExecutionCoordinator;
  readonly #receipts: GovernorTrustedReceiptResolver;
  readonly reducers: GovernorFaninReducerStore;

  constructor(params: {
    stateDir?: string;
    options?: OpenClawStateDatabaseOptions;
    physicalExecutionCoordinator: GovernorTrustedPhysicalExecutionCoordinator;
    receiptResolver: GovernorTrustedReceiptResolver;
  }) {
    if (
      !isTrustedGovernorPhysicalExecutionCoordinator(params.physicalExecutionCoordinator) ||
      !isTrustedGovernorReceiptResolver(params.receiptResolver)
    ) {
      throw new Error("Governor fanout requires trusted host physical execution bindings");
    }
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    initializeGovernorStateSchema(this.#options);
    this.reducers = new GovernorFaninReducerStore({ options: this.#options });
    this.#physical = params.physicalExecutionCoordinator;
    this.#receipts = params.receiptResolver;
  }

  #task(db: DatabaseSync, taskId: GovernorTaskId): GovernorTaskProjection | null {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      fanoutDb(db)
        .selectFrom("governor_tasks")
        .select(["projection_json"])
        .where("task_id", "=", taskId),
    );
    return row ? parseTaskProjection(row.projection_json) : null;
  }

  enqueue(params: {
    jobId: string;
    task: GovernorTaskProjection;
    round: number;
    priority: number;
    fanoutGroup: string;
    expectedOutputTokens?: number;
    expectedDurationMs?: number;
    payload: GovernorJsonValue;
    now: number;
  }): GovernorFanoutJob {
    assertGovernorPersistedJson("log", params);
    const payload = assertGovernorBoundarySafe("model", params.payload);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        fanoutDb(db)
          .selectFrom("governor_fanout_jobs")
          .selectAll()
          .where("job_id", "=", params.jobId),
      );
      if (existing) {
        const job = parseJob(existing);
        const sameIntent =
          job.taskId === params.task.taskId &&
          job.planVersion === params.task.planVersion &&
          job.round === params.round &&
          job.priority === params.priority &&
          job.fanoutGroup === params.fanoutGroup &&
          job.taskVersion === params.task.taskVersion &&
          job.objectiveRevision === params.task.objectiveRevision &&
          job.leaseEpoch === params.task.leaseEpoch &&
          job.executionGeneration === params.task.executionGeneration &&
          job.expectedOutputTokens === params.expectedOutputTokens &&
          job.expectedDurationMs === params.expectedDurationMs &&
          governorDigest(job.payload) === governorDigest(payload);
        if (!sameIntent) {
          throw new Error(`Conflicting governor fanout job id ${params.jobId}`);
        }
        return job;
      }
      const current = this.#task(db, params.task.taskId);
      if (
        !current ||
        current.state !== "EXECUTING" ||
        current.taskVersion !== params.task.taskVersion ||
        current.planVersion !== params.task.planVersion ||
        current.leaseEpoch !== params.task.leaseEpoch ||
        current.executionGeneration !== params.task.executionGeneration
      ) {
        throw new Error(`Stale governor fanout enqueue for ${params.task.taskId}`);
      }
      const maxSequence = executeSqliteQueryTakeFirstSync(
        db,
        fanoutDb(db)
          .selectFrom("governor_fanout_jobs")
          .select((eb) => eb.fn.max("queue_sequence").as("max_sequence")),
      ) as { max_sequence: number | bigint | null } | undefined;
      const job: GovernorFanoutJob = {
        jobId: params.jobId,
        taskId: params.task.taskId,
        planVersion: params.task.planVersion,
        round: params.round,
        queueSequence: (normalizeSqliteNumber(maxSequence?.max_sequence ?? null) ?? 0) + 1,
        priority: params.priority,
        fanoutGroup: params.fanoutGroup,
        state: "queued",
        taskVersion: params.task.taskVersion,
        objectiveRevision: params.task.objectiveRevision,
        leaseEpoch: params.task.leaseEpoch,
        executionGeneration: params.task.executionGeneration,
        claimEpoch: 0,
        ...(params.expectedOutputTokens === undefined
          ? {}
          : { expectedOutputTokens: params.expectedOutputTokens }),
        ...(params.expectedDurationMs === undefined
          ? {}
          : { expectedDurationMs: params.expectedDurationMs }),
        payload,
        createdAt: params.now,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        fanoutDb(db).insertInto("governor_fanout_jobs").values(bindJob(job)),
      );
      return job;
    }, this.#options);
  }

  claimNext(params: {
    workerId: string;
    now: number;
    leaseDurationMs?: number;
  }): GovernorFanoutClaim {
    assertGovernorPersistedJson("log", {
      workerId: params.workerId,
      now: params.now,
      leaseDurationMs: params.leaseDurationMs ?? null,
    });
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("Governor fanout workerId must not be empty");
    }
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor fanout leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const reconciliation = reconcileFanoutPhysicalState({
        db,
        coordinator: this.#physical,
        now: params.now,
      });
      if (reconciliation.unprovableRunning) {
        return { kind: "saturated" };
      }
      for (;;) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          fanoutDb(db)
            .selectFrom("governor_fanout_jobs")
            .selectAll()
            .where("state", "=", "queued")
            .orderBy("queue_sequence", "asc")
            .orderBy("job_id", "asc")
            .limit(1),
        );
        if (!row) {
          return { kind: "empty" };
        }
        const job = parseJob(row);
        const task = this.#task(db, job.taskId);
        if (
          !task ||
          task.planVersion !== job.planVersion ||
          task.executionGeneration !== job.executionGeneration ||
          task.leaseEpoch !== job.leaseEpoch
        ) {
          executeSqliteQuerySync(
            db,
            fanoutDb(db)
              .updateTable("governor_fanout_jobs")
              .set({
                state: "cancelled",
                cancelled_at: params.now,
                worker_id: null,
                lease_expires_at: null,
                updated_at: params.now,
              })
              .where("job_id", "=", job.jobId)
              .where("state", "=", "queued"),
          );
          continue;
        }
        const {
          cancellationDisposition: _cancellationDisposition,
          cancellationRequestedAt: _cancellationRequestedAt,
          physicalBindingDigest: _physicalBindingDigest,
          physicalGeneration: _physicalGeneration,
          physicalSlot: _physicalSlot,
          terminationAcknowledgedAt: _terminationAcknowledgedAt,
          terminationEvidenceDigest: _terminationEvidenceDigest,
          terminationOutcome: _terminationOutcome,
          ...claimable
        } = job;
        const claimed: GovernorFanoutJob = {
          ...claimable,
          state: "running",
          claimEpoch: job.claimEpoch + 1,
          workerId,
          leaseExpiresAt: params.now + leaseDurationMs,
          startedAt: params.now,
          updatedAt: params.now,
        };
        const physical = this.#physical.claim(fanoutPhysicalBinding(claimed));
        if (physical.kind === "saturated") {
          return { kind: "saturated" };
        }
        if (physical.kind === "already_active") {
          const restored: GovernorFanoutJob = {
            ...claimed,
            physicalSlot: physical.lease.slot,
            physicalGeneration: physical.lease.generation,
            physicalBindingDigest: physical.lease.bindingDigest,
            cancellationDisposition: "cancel",
            cancellationRequestedAt: params.now,
          };
          executeSqliteQuerySync(
            db,
            fanoutDb(db)
              .updateTable("governor_fanout_jobs")
              .set(bindJob(restored))
              .where("job_id", "=", job.jobId)
              .where("state", "=", "queued"),
          );
          requestFanoutCancellation({
            db,
            coordinator: this.#physical,
            job: restored,
            disposition: "cancel",
            now: params.now,
          });
          continue;
        }
        const physicallyClaimed: GovernorFanoutJob = {
          ...claimed,
          physicalSlot: physical.lease.slot,
          physicalGeneration: physical.lease.generation,
          physicalBindingDigest: physical.lease.bindingDigest,
        };
        const update = executeSqliteQuerySync(
          db,
          fanoutDb(db)
            .updateTable("governor_fanout_jobs")
            .set(bindJob(physicallyClaimed))
            .where("job_id", "=", job.jobId)
            .where("state", "=", "queued"),
        );
        if (update.numAffectedRows === 1n) {
          return { kind: "claimed", job: physicallyClaimed };
        }
        this.#physical.requestCancellation(
          fanoutPhysicalBinding(physicallyClaimed),
          physical.lease,
        );
        throw new Error(`Governor fanout physical claim lost its durable row ${job.jobId}`);
      }
    }, this.#options);
  }

  cancelJob(jobId: string, now: number): boolean {
    assertGovernorPersistedJson("log", { jobId, now });
    return cancelFanoutJob(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      { jobId, now },
    );
  }

  requestRetirement(jobId: string, disposition: "cancel" | "requeue", now: number): boolean {
    assertGovernorPersistedJson("log", { jobId, disposition, now });
    return cancelFanoutJob(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      { jobId, disposition, now },
    );
  }

  heartbeat(params: {
    jobId: string;
    claimEpoch: number;
    workerId: string;
    now: number;
    leaseDurationMs?: number;
  }): boolean {
    assertGovernorPersistedJson("log", {
      jobId: params.jobId,
      claimEpoch: params.claimEpoch,
      workerId: params.workerId,
      now: params.now,
      leaseDurationMs: params.leaseDurationMs ?? null,
    });
    return heartbeatFanoutJob(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      { ...params, leaseDurationMs: params.leaseDurationMs ?? 60_000 },
    );
  }

  acknowledgeTermination(params: {
    jobId: string;
    receiptId: HostGovernorReceiptId;
    outcome: "crashed" | "terminated";
    now: number;
  }): boolean {
    assertGovernorPersistedJson("log", params);
    return acknowledgeFanoutTermination(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      params,
    );
  }

  acknowledgeOrphanedTermination(params: {
    taskId: string;
    scopeKey: string;
    taskVersion: number;
    objectiveRevision: number;
    planVersion: number;
    receiptId: HostGovernorReceiptId;
    slot: number;
    generation: number;
    bindingDigest: string;
    outcome: "crashed" | "terminated";
    now: number;
  }): boolean {
    assertGovernorPersistedJson("log", params);
    return acknowledgeOrphanedFanoutTermination(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      params,
    );
  }

  complete(
    params: import("./fanout-completion.js").CompleteFanoutParams,
  ): GovernorFanoutCompletion {
    return completeFanoutJob(
      { options: this.#options, physical: this.#physical, receipts: this.#receipts },
      params,
    );
  }

  listJobs(taskId: GovernorTaskId): GovernorFanoutJob[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      fanoutDb(db)
        .selectFrom("governor_fanout_jobs")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows.map(parseJob);
  }

  claimReducer(params: GovernorClaimReducerParams): GovernorReducerClaim {
    return this.reducers.claim(params);
  }

  completeReducer(params: GovernorCompleteReducerParams): boolean {
    return this.reducers.complete(params);
  }
}
