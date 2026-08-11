// Encodes durable FIFO subagent jobs and immutable fan-in envelopes.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type FanoutDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_tasks" | "governor_fanout_jobs" | "governor_fanin_envelopes" | "governor_fanin_reducers"
>;
type FanoutJobRow = Selectable<OpenClawStateKyselyDatabase["governor_fanout_jobs"]>;
type FaninEnvelopeRow = Selectable<OpenClawStateKyselyDatabase["governor_fanin_envelopes"]>;
export type FaninReducerRow = Selectable<OpenClawStateKyselyDatabase["governor_fanin_reducers"]>;

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

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid governor fanout ${label}`, { cause: error });
  }
}

export function parseJob(row: FanoutJobRow): GovernorFanoutJob {
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

export function bindJob(job: GovernorFanoutJob): Insertable<FanoutJobRow> {
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

export function parseEnvelope(row: FaninEnvelopeRow): GovernorFaninEnvelope {
  const envelope = parseJson(row.envelope_json, "envelope") as GovernorFaninEnvelope;
  if (envelope.envelopeDigest !== row.envelope_digest || envelope.jobId !== row.job_id) {
    throw new Error(`Governor fan-in envelope mismatch for ${row.job_id}`);
  }
  return envelope;
}

export function bindEnvelope(envelope: GovernorFaninEnvelope): Insertable<FaninEnvelopeRow> {
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

export function parseTaskProjection(raw: string): GovernorTaskProjection {
  return parseJson(raw, "task projection") as GovernorTaskProjection;
}

export function parseReducerResult(raw: string): GovernorJsonValue {
  return parseJson(raw, "reducer result") as GovernorJsonValue;
}

export function fanoutDb(db: DatabaseSync) {
  return getNodeSqliteKysely<FanoutDatabase>(db);
}
