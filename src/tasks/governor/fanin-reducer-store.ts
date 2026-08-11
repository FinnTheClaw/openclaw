// Owns the CAS-fenced, single-writer reducer for immutable fan-in envelopes.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  fanoutDb,
  parseEnvelope,
  parseJob,
  parseReducerResult,
  parseTaskProjection,
  type FaninReducerRow,
  type GovernorReducerClaim,
} from "./fanout-codec.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorClaimReducerParams = {
  task: GovernorTaskProjection;
  round: number;
  now: number;
  leaseDurationMs?: number;
};

export type GovernorCompleteReducerParams = {
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
};

export class GovernorFaninReducerStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string; options?: OpenClawStateDatabaseOptions } = {}) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    initializeGovernorStateSchema(this.#options);
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

  claim(params: GovernorClaimReducerParams): GovernorReducerClaim {
    assertGovernorPersistedJson("log", {
      task: params.task,
      round: params.round,
      now: params.now,
      leaseDurationMs: params.leaseDurationMs ?? null,
    });
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
        fanoutDb(db)
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
        fanoutDb(db)
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
        fanoutDb(db)
          .selectFrom("governor_fanin_reducers")
          .selectAll()
          .where("task_id", "=", current.taskId)
          .where("plan_version", "=", current.planVersion)
          .where("round", "=", params.round),
      );
      if (reducer?.state === "completed" && reducer.result_json && reducer.result_digest) {
        return {
          kind: "completed",
          result: parseReducerResult(reducer.result_json),
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
        fanoutDb(db)
          .insertInto("governor_fanin_reducers")
          .values(values)
          .onConflict((conflict) =>
            conflict.columns(["task_id", "plan_version", "round"]).doUpdateSet(values),
          ),
      );
      return { kind: "claimed", reducerEpoch, envelopeSetDigest, envelopes };
    }, this.#options);
  }

  complete(params: GovernorCompleteReducerParams): boolean {
    assertGovernorPersistedJson("log", params);
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
        fanoutDb(db)
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
