// Provides a durable FIFO subagent queue, three-slot admission, and CAS-fenced structured fan-in.
import type { DatabaseSync } from "node:sqlite";
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
  GovernorFaninReducerStore,
  type GovernorClaimReducerParams,
  type GovernorCompleteReducerParams,
} from "./fanin-reducer-store.js";
import {
  bindEnvelope,
  bindJob,
  fanoutDb,
  parseEnvelope,
  parseJob,
  parseTaskProjection,
  type GovernorFaninEnvelope,
  type GovernorFanoutClaim,
  type GovernorFanoutCompletion,
  type GovernorFanoutJob,
  type GovernorReducerClaim,
} from "./fanout-codec.js";
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
  readonly reducers: GovernorFaninReducerStore;

  constructor(params: { stateDir?: string; options?: OpenClawStateDatabaseOptions } = {}) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    initializeGovernorStateSchema(this.#options);
    this.reducers = new GovernorFaninReducerStore({ options: this.#options });
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
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("Governor fanout workerId must not be empty");
    }
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor fanout leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        fanoutDb(db)
          .updateTable("governor_fanout_jobs")
          .set({
            state: "queued",
            worker_id: null,
            lease_expires_at: null,
            updated_at: params.now,
          })
          .where("state", "=", "running")
          .where("lease_expires_at", "<=", params.now),
      );
      const running = executeSqliteQueryTakeFirstSync(
        db,
        fanoutDb(db)
          .selectFrom("governor_fanout_jobs")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("state", "=", "running"),
      ) as { count: number | bigint } | undefined;
      if (Number(running?.count ?? 0) >= MAX_GOVERNOR_PHYSICAL_EXECUTIONS) {
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
        const claimed: GovernorFanoutJob = {
          ...job,
          state: "running",
          claimEpoch: job.claimEpoch + 1,
          workerId,
          leaseExpiresAt: params.now + leaseDurationMs,
          startedAt: params.now,
          updatedAt: params.now,
        };
        const update = executeSqliteQuerySync(
          db,
          fanoutDb(db)
            .updateTable("governor_fanout_jobs")
            .set(bindJob(claimed))
            .where("job_id", "=", job.jobId)
            .where("state", "=", "queued"),
        );
        if (update.numAffectedRows === 1n) {
          return { kind: "claimed", job: claimed };
        }
      }
    }, this.#options);
  }

  cancelJob(jobId: string, now: number): boolean {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const update = executeSqliteQuerySync(
        db,
        fanoutDb(db)
          .updateTable("governor_fanout_jobs")
          .set({
            state: "cancelled",
            cancelled_at: now,
            worker_id: null,
            lease_expires_at: null,
            updated_at: now,
          })
          .where("job_id", "=", jobId)
          .where("state", "in", ["queued", "running"]),
      );
      return update.numAffectedRows === 1n;
    }, this.#options);
  }

  complete(params: {
    jobId: string;
    taskVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    claimEpoch: number;
    workerId: string;
    claims: readonly GovernorJsonValue[];
    evidence: readonly GovernorJsonValue[];
    unresolved: readonly GovernorJsonValue[];
    now: number;
  }): GovernorFanoutCompletion {
    const content = assertGovernorBoundarySafe("session", {
      claims: [...params.claims],
      evidence: [...params.evidence],
      unresolved: [...params.unresolved],
    });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        fanoutDb(db)
          .selectFrom("governor_fanout_jobs")
          .selectAll()
          .where("job_id", "=", params.jobId),
      );
      if (!row) {
        return { kind: "not_found" };
      }
      const job = parseJob(row);
      const envelopePayload = content as {
        claims: GovernorJsonValue[];
        evidence: GovernorJsonValue[];
        unresolved: GovernorJsonValue[];
      };
      const envelopeDigest = governorDigest({
        jobId: job.jobId,
        taskId: job.taskId,
        planVersion: job.planVersion,
        round: job.round,
        ...envelopePayload,
      });
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        fanoutDb(db)
          .selectFrom("governor_fanin_envelopes")
          .selectAll()
          .where("job_id", "=", job.jobId),
      );
      if (existing) {
        const envelope = parseEnvelope(existing);
        return envelope.envelopeDigest === envelopeDigest
          ? { kind: "duplicate", envelope }
          : { kind: "conflict" };
      }
      const task = this.#task(db, job.taskId);
      const staleTask =
        !task ||
        task.planVersion !== job.planVersion ||
        task.leaseEpoch !== job.leaseEpoch ||
        task.executionGeneration !== job.executionGeneration;
      const staleWorker =
        job.taskVersion !== params.taskVersion ||
        job.leaseEpoch !== params.leaseEpoch ||
        job.executionGeneration !== params.executionGeneration ||
        job.claimEpoch !== params.claimEpoch ||
        job.workerId !== params.workerId;
      if (staleTask || staleWorker) {
        if (staleTask && job.state !== "completed") {
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
              .where("job_id", "=", job.jobId),
          );
        }
        return { kind: "stale_worker" };
      }
      if (job.state !== "running") {
        return { kind: "stale_worker" };
      }
      const envelope: GovernorFaninEnvelope = {
        envelopeId: `envelope_${job.jobId}`,
        jobId: job.jobId,
        taskId: job.taskId,
        planVersion: job.planVersion,
        round: job.round,
        taskVersion: params.taskVersion,
        leaseEpoch: params.leaseEpoch,
        executionGeneration: params.executionGeneration,
        claims: envelopePayload.claims,
        evidence: envelopePayload.evidence,
        unresolved: envelopePayload.unresolved,
        envelopeDigest,
        createdAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        fanoutDb(db).insertInto("governor_fanin_envelopes").values(bindEnvelope(envelope)),
      );
      executeSqliteQuerySync(
        db,
        fanoutDb(db)
          .updateTable("governor_fanout_jobs")
          .set({
            state: "completed",
            completed_at: params.now,
            worker_id: null,
            lease_expires_at: null,
            updated_at: params.now,
          })
          .where("job_id", "=", job.jobId)
          .where("state", "=", "running"),
      );
      return { kind: "completed", envelope };
    }, this.#options);
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
