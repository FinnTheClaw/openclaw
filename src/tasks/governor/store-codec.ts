// Encodes and validates durable governor task, event, effect, and evidence rows.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import type { GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import type { GovernorEventId, GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "governor_tasks"
  | "governor_events"
  | "governor_action_intents"
  | "governor_checkpoints"
  | "governor_effects"
  | "governor_evidence"
  | "governor_outbox"
  | "governor_scope_epochs"
  | "governor_fanout_jobs"
>;

type GovernorTaskRow = Selectable<OpenClawStateKyselyDatabase["governor_tasks"]>;
type GovernorEventRow = Selectable<OpenClawStateKyselyDatabase["governor_events"]>;
type GovernorEffectRow = Selectable<OpenClawStateKyselyDatabase["governor_effects"]>;
type GovernorEvidenceRow = Selectable<OpenClawStateKyselyDatabase["governor_evidence"]>;

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid persisted governor ${label}`, { cause: error });
  }
}

export function parseTaskRow(row: GovernorTaskRow): GovernorTaskProjection {
  const projection = parseJson<GovernorTaskProjection>(row.projection_json, "task projection");
  if (projection.taskId !== row.task_id || projection.scopeKey !== row.scope_key) {
    throw new Error(`Persisted governor task projection identity mismatch for ${row.task_id}`);
  }
  return {
    ...projection,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    executionGeneration: normalizeSqliteNumber(row.execution_generation) ?? 0,
    authenticatedSourceSequence: normalizeSqliteNumber(row.source_sequence) ?? 0,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(row.terminal_at == null ? {} : { terminalAt: normalizeSqliteNumber(row.terminal_at) ?? 0 }),
  };
}

export function bindTask(task: GovernorTaskProjection): Insertable<GovernorTaskRow> {
  return {
    task_id: task.taskId,
    flow_id: task.flowId ?? null,
    scope_key: task.scopeKey,
    state: task.state,
    mode: task.mode,
    task_version: task.taskVersion,
    objective_revision: task.objectiveRevision,
    plan_version: task.planVersion,
    lease_epoch: task.leaseEpoch,
    execution_generation: task.executionGeneration,
    source_sequence: task.authenticatedSourceSequence,
    projection_json: JSON.stringify(task),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    terminal_at: task.terminalAt ?? null,
  };
}

export function bindEvent(event: GovernorEventRecord): Insertable<GovernorEventRow> {
  return {
    event_id: event.eventId,
    task_id: event.taskId,
    scope_key: event.scopeKey,
    source_message_id: event.sourceMessageId ?? null,
    source_sequence: event.sourceSequence ?? null,
    event_type: event.eventType,
    task_version: event.taskVersion,
    objective_revision: event.objectiveRevision,
    payload_json: JSON.stringify(event.payload),
    payload_digest: event.payloadDigest,
    created_at: event.createdAt,
  };
}

export function parseEventRow(row: GovernorEventRow): GovernorEventRecord {
  return {
    eventId: row.event_id as GovernorEventId,
    taskId: row.task_id as GovernorTaskId,
    scopeKey: row.scope_key,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.source_sequence == null
      ? {}
      : { sourceSequence: normalizeSqliteNumber(row.source_sequence) ?? 0 }),
    eventType: row.event_type as GovernorEventRecord["eventType"],
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    payload: parseJson<GovernorJsonValue>(row.payload_json, "event payload"),
    payloadDigest: row.payload_digest,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
  };
}

export function bindEffect(effect: GovernorEffectRecord): Insertable<GovernorEffectRow> {
  return {
    task_id: effect.taskId,
    effect_id: effect.effectId,
    idempotency_key: effect.idempotencyKey,
    task_version: effect.taskVersion,
    objective_revision: effect.objectiveRevision,
    plan_version: effect.planVersion,
    lease_epoch: effect.leaseEpoch,
    execution_generation: effect.executionGeneration,
    capability: effect.capability,
    canonical_target: effect.canonicalTarget,
    criterion_id: effect.criterionId ?? null,
    action_fingerprint: effect.actionFingerprint,
    progress_vector_hash: effect.progressVectorHash,
    mutating: effect.mutating ? 1 : 0,
    effect_json: JSON.stringify(effect),
    outcome_json: JSON.stringify(effect.outcome),
    verification_state: effect.verificationState,
    reconcile_required: effect.reconcileRequired ? 1 : 0,
    created_at: effect.createdAt,
    updated_at: effect.updatedAt,
  };
}

export function parseEffectRow(row: GovernorEffectRow): GovernorEffectRecord {
  const effect = parseJson<GovernorEffectRecord>(row.effect_json, "effect");
  if (effect.taskId !== row.task_id || effect.effectId !== row.effect_id) {
    throw new Error(`Persisted governor effect identity mismatch for ${row.effect_id}`);
  }
  return effect;
}

export function bindEvidence(evidence: GovernorEvidenceRecord): Insertable<GovernorEvidenceRow> {
  return {
    evidence_id: evidence.evidenceId,
    task_id: evidence.taskId,
    criterion_id: evidence.criterionId,
    source_kind: evidence.sourceKind,
    source_identity: evidence.sourceIdentity,
    task_version: evidence.taskVersion,
    objective_revision: evidence.objectiveRevision,
    scope_key: evidence.scopeKey,
    observed_at: evidence.observedAt,
    evidence_digest: evidence.evidenceDigest,
    payload_json: JSON.stringify(evidence.payload),
    admissibility: evidence.admissibility,
    invalidated_at: evidence.invalidatedAt ?? null,
    created_at: evidence.createdAt,
  };
}

export function parseEvidenceRow(row: GovernorEvidenceRow): GovernorEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    taskId: row.task_id as GovernorTaskId,
    criterionId: row.criterion_id,
    sourceKind: row.source_kind as GovernorEvidenceRecord["sourceKind"],
    sourceIdentity: row.source_identity,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    scopeKey: row.scope_key,
    observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
    payload: parseJson<GovernorJsonValue>(row.payload_json, "evidence payload"),
    evidenceDigest: row.evidence_digest,
    admissibility: "admitted",
    ...(row.invalidated_at == null
      ? {}
      : { invalidatedAt: normalizeSqliteNumber(row.invalidated_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
  };
}

export function governorDb(db: DatabaseSync) {
  return getNodeSqliteKysely<GovernorDatabase>(db);
}
