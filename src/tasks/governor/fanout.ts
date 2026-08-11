// Provides a durable FIFO subagent queue, three-slot admission, and CAS-fenced structured fan-in.
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

export const MAX_GOVERNOR_PHYSICAL_EXECUTIONS = 3;

type FanoutDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_tasks" | "governor_fanout_jobs" | "governor_fanin_envelopes" | "governor_fanin_reducers"
>;
type FanoutJobRow = Selectable<OpenClawStateKyselyDatabase["governor_fanout_jobs"]>;
type FaninEnvelopeRow = Selectable<OpenClawStateKyselyDatabase["governor_fanin_envelopes"]>;
type FaninReducerRow = Selectable<OpenClawStateKyselyDatabase["governor_fanin_reducers"]>;

export type GovernorFanoutJobState = "queued" | "running" | "completed" | "cancelled";

export type GovernorFanoutJob = {
  jobId: string;
  taskId: GovernorTaskId;
  planVersion: number;
  round: number;
  queueSequence: number;
  priority: number;
  fanoutGroup: string;
  state: GovernorFanoutJobState;
  taskVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  claimEpoch: number;
  workerId?: string;
  leaseExpiresAt?: number;
  expectedOutputTokens?: number;
  expectedDurationMs?: number;
  payload: GovernorJsonValue;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  updatedAt: number;
};

export type GovernorFaninEnvelope = {
  envelopeId: string;
  jobId: string;
  taskId: GovernorTaskId;
  planVersion: number;
  round: number;
  taskVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  claims: readonly GovernorJsonValue[];
  evidence: readonly GovernorJsonValue[];
  unresolved: readonly GovernorJsonValue[];
  envelopeDigest: string;
  createdAt: number;
};

export type GovernorFanoutClaim =
  | { kind: "claimed"; job: GovernorFanoutJob }
  | { kind: "saturated" | "empty" };

export type GovernorFanoutCompletion =
  | { kind: "completed" | "duplicate"; envelope: GovernorFaninEnvelope }
  | { kind: "conflict" | "stale_worker" | "not_found" };

export type GovernorReducerClaim =
  | {
      kind: "claimed";
      reducerEpoch: number;
      envelopeSetDigest: string;
      envelopes: readonly GovernorFaninEnvelope[];
    }
  | { kind: "busy" | "not_ready" | "stale_task" }
  | { kind: "completed"; result: GovernorJsonValue; resultDigest: string };

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<FanoutDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid governor fanout ${label}`, { cause: error });
  }
}

function parseJob(row: FanoutJobRow): GovernorFanoutJob {
  return {
    jobId: row.job_id,
    taskId: row.task_id as GovernorTaskId,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    round: normalizeSqliteNumber(row.round) ?? 0,
    queueSequence: normalizeSqliteNumber(row.queue_sequence) ?? 0,
    priority: normalizeSqliteNumber(row.priority) ?? 0,
    fanoutGroup: row.fanout_group,
    state: row.state as GovernorFanoutJobState,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    executionGeneration: normalizeSqliteNumber(row.execution_generation) ?? 0,
    claimEpoch: normalizeSqliteNumber(row.claim_epoch) ?? 0,
    ...(row.worker_id == null ? {} : { workerId: row.worker_id }),
    ...(row.lease_expires_at == null
      ? {}
      : { leaseExpiresAt: normalizeSqliteNumber(row.lease_expires_at) ?? 0 }),
    ...(row.expected_output_tokens == null
      ? {}
      : { expectedOutputTokens: normalizeSqliteNumber(row.expected_output_tokens) ?? 0 }),
    ...(row.expected_duration_ms == null
      ? {}
      : { expectedDurationMs: normalizeSqliteNumber(row.expected_duration_ms) ?? 0 }),
    payload: parseJson(row.payload_json, "job payload") as GovernorJsonValue,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(row.started_at == null ? {} : { startedAt: normalizeSqliteNumber(row.started_at) ?? 0 }),
    ...(row.completed_at == null
      ? {}
      : { completedAt: normalizeSqliteNumber(row.completed_at) ?? 0 }),
    ...(row.cancelled_at == null
      ? {}
      : { cancelledAt: normalizeSqliteNumber(row.cancelled_at) ?? 0 }),
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

function bindJob(job: GovernorFanoutJob): Insertable<FanoutJobRow> {
  return {
    job_id: job.jobId,
    task_id: job.taskId,
    plan_version: job.planVersion,
    round: job.round,
    queue_sequence: job.queueSequence,
    priority: job.priority,
    fanout_group: job.fanoutGroup,
    state: job.state,
    task_version: job.taskVersion,
    lease_epoch: job.leaseEpoch,
    execution_generation: job.executionGeneration,
    claim_epoch: job.claimEpoch,
    worker_id: job.workerId ?? null,
    lease_expires_at: job.leaseExpiresAt ?? null,
    expected_output_tokens: job.expectedOutputTokens ?? null,
    expected_duration_ms: job.expectedDurationMs ?? null,
    payload_json: JSON.stringify(job.payload),
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    cancelled_at: job.cancelledAt ?? null,
    updated_at: job.updatedAt,
  };
}

function parseEnvelope(row: FaninEnvelopeRow): GovernorFaninEnvelope {
  const envelope = parseJson(row.envelope_json, "envelope") as GovernorFaninEnvelope;
  if (envelope.envelopeDigest !== row.envelope_digest || envelope.jobId !== row.job_id) {
    throw new Error(`Governor fan-in envelope mismatch for ${row.job_id}`);
  }
  return envelope;
}

function bindEnvelope(envelope: GovernorFaninEnvelope): Insertable<FaninEnvelopeRow> {
  return {
    envelope_id: envelope.envelopeId,
    job_id: envelope.jobId,
    task_id: envelope.taskId,
    plan_version: envelope.planVersion,
    round: envelope.round,
    task_version: envelope.taskVersion,
    lease_epoch: envelope.leaseEpoch,
    execution_generation: envelope.executionGeneration,
    envelope_json: JSON.stringify(envelope),
    envelope_digest: envelope.envelopeDigest,
    created_at: envelope.createdAt,
  };
}

function parseTaskProjection(raw: string): GovernorTaskProjection {
  return parseJson(raw, "task projection") as GovernorTaskProjection;
}

export class GovernorFanoutStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
  }

  #database() {
    return openOpenClawStateDatabase(this.#options);
  }

  #task(db: DatabaseSync, taskId: GovernorTaskId): GovernorTaskProjection | null {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
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
        dbx(db).selectFrom("governor_fanout_jobs").selectAll().where("job_id", "=", params.jobId),
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
        dbx(db)
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
      executeSqliteQuerySync(db, dbx(db).insertInto("governor_fanout_jobs").values(bindJob(job)));
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
        dbx(db)
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
        dbx(db)
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
          dbx(db)
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
            dbx(db)
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
          dbx(db)
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
        dbx(db)
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
        dbx(db).selectFrom("governor_fanout_jobs").selectAll().where("job_id", "=", params.jobId),
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
        dbx(db).selectFrom("governor_fanin_envelopes").selectAll().where("job_id", "=", job.jobId),
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
            dbx(db)
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
        dbx(db).insertInto("governor_fanin_envelopes").values(bindEnvelope(envelope)),
      );
      executeSqliteQuerySync(
        db,
        dbx(db)
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
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_fanout_jobs")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows.map(parseJob);
  }

  claimReducer(params: {
    task: GovernorTaskProjection;
    round: number;
    now: number;
    leaseDurationMs?: number;
  }): GovernorReducerClaim {
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor reducer leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = this.#task(db, params.task.taskId);
      if (
        !current ||
        current.taskVersion !== params.task.taskVersion ||
        current.leaseEpoch !== params.task.leaseEpoch ||
        current.planVersion !== params.task.planVersion ||
        current.executionGeneration !== params.task.executionGeneration
      ) {
        return { kind: "stale_task" };
      }
      const jobs = executeSqliteQuerySync(
        db,
        dbx(db)
          .selectFrom("governor_fanout_jobs")
          .selectAll()
          .where("task_id", "=", current.taskId)
          .where("plan_version", "=", current.planVersion)
          .where("round", "=", params.round)
          .orderBy("queue_sequence", "asc"),
      ).rows.map(parseJob);
      if (
        jobs.length === 0 ||
        jobs.some((job) => job.state === "queued" || job.state === "running")
      ) {
        return { kind: "not_ready" };
      }
      const envelopes = executeSqliteQuerySync(
        db,
        dbx(db)
          .selectFrom("governor_fanin_envelopes")
          .selectAll()
          .where("task_id", "=", current.taskId)
          .where("plan_version", "=", current.planVersion)
          .where("round", "=", params.round)
          .orderBy("job_id", "asc"),
      ).rows.map(parseEnvelope);
      const envelopeSetDigest = governorDigest(
        envelopes.map((envelope) => ({
          jobId: envelope.jobId,
          envelopeDigest: envelope.envelopeDigest,
        })),
      );
      const reducer = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_fanin_reducers")
          .selectAll()
          .where("task_id", "=", current.taskId)
          .where("plan_version", "=", current.planVersion)
          .where("round", "=", params.round),
      );
      if (reducer?.state === "completed" && reducer.result_json && reducer.result_digest) {
        return {
          kind: "completed",
          result: parseJson(reducer.result_json, "reducer result") as GovernorJsonValue,
          resultDigest: reducer.result_digest,
        };
      }
      if (
        reducer?.state === "claimed" &&
        params.now - (normalizeSqliteNumber(reducer.claimed_at) ?? params.now) < leaseDurationMs
      ) {
        return { kind: "busy" };
      }
      const reducerEpoch = (normalizeSqliteNumber(reducer?.reducer_epoch ?? null) ?? 0) + 1;
      const values: Insertable<FaninReducerRow> = {
        task_id: current.taskId,
        plan_version: current.planVersion,
        round: params.round,
        reducer_epoch: reducerEpoch,
        state: "claimed",
        envelope_set_digest: envelopeSetDigest,
        result_json: null,
        result_digest: null,
        claimed_at: params.now,
        completed_at: null,
        updated_at: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_fanin_reducers")
          .values(values)
          .onConflict((conflict) =>
            conflict.columns(["task_id", "plan_version", "round"]).doUpdateSet(values),
          ),
      );
      return { kind: "claimed", reducerEpoch, envelopeSetDigest, envelopes };
    }, this.#options);
  }

  completeReducer(params: {
    taskId: GovernorTaskId;
    planVersion: number;
    round: number;
    taskVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    reducerEpoch: number;
    envelopeSetDigest: string;
    result: GovernorJsonValue;
    now: number;
  }): boolean {
    const result = assertGovernorBoundarySafe("session", params.result);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = this.#task(db, params.taskId);
      if (
        !task ||
        task.taskVersion !== params.taskVersion ||
        task.planVersion !== params.planVersion ||
        task.leaseEpoch !== params.leaseEpoch ||
        task.executionGeneration !== params.executionGeneration
      ) {
        return false;
      }
      const update = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_fanin_reducers")
          .set({
            state: "completed",
            result_json: JSON.stringify(result),
            result_digest: governorDigest(result),
            completed_at: params.now,
            updated_at: params.now,
          })
          .where("task_id", "=", params.taskId)
          .where("plan_version", "=", params.planVersion)
          .where("round", "=", params.round)
          .where("reducer_epoch", "=", params.reducerEpoch)
          .where("envelope_set_digest", "=", params.envelopeSetDigest)
          .where("state", "=", "claimed"),
      );
      return update.numAffectedRows === 1n;
    }, this.#options);
  }
}
