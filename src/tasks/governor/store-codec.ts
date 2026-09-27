// Encodes and validates durable governor task, event, effect, and evidence rows.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import { isOpaqueEvidenceSourceRef } from "./evidence.js";
import { parseGovernorStoredJson } from "./integrity-error.js";
import { assertGovernorPersistedJson, assertOpaqueGovernorScope } from "./persistence-guard.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  isOpaqueGovernorReference,
  type GovernorEventId,
  type GovernorTaskId,
  type GovernorTaskProjection,
} from "./types.js";

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
  | "governor_fanin_reducers"
  | "governor_ingress_source_highwater"
>;

type GovernorTaskRow = Selectable<OpenClawStateKyselyDatabase["governor_tasks"]>;
type GovernorEventRow = Selectable<OpenClawStateKyselyDatabase["governor_events"]>;
type GovernorEffectRow = Selectable<OpenClawStateKyselyDatabase["governor_effects"]>;
type GovernorEvidenceRow = Selectable<OpenClawStateKyselyDatabase["governor_evidence"]>;

export function parseTaskRow(row: GovernorTaskRow): GovernorTaskProjection {
  const projection = parseGovernorStoredJson(
    row.projection_json,
    "log",
    "GOVERNOR_TASK_PROJECTION_INVALID",
  ) as unknown as GovernorTaskProjection;
  const task: GovernorTaskProjection = {
    ...projection,
    conditions: projection.conditions ?? { contradictions: [], pendingUserUpdate: false },
    claims: projection.claims ?? [],
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
  if (
    projection.taskId !== row.task_id ||
    projection.flowId !== (row.flow_id ?? undefined) ||
    projection.scopeKey !== row.scope_key ||
    projection.state !== row.state ||
    projection.mode !== row.mode ||
    projection.taskVersion !== task.taskVersion ||
    projection.objectiveRevision !== task.objectiveRevision ||
    projection.planVersion !== task.planVersion ||
    projection.leaseEpoch !== task.leaseEpoch ||
    projection.executionGeneration !== task.executionGeneration ||
    projection.authenticatedSourceSequence !== task.authenticatedSourceSequence ||
    projection.createdAt !== task.createdAt ||
    projection.updatedAt !== task.updatedAt ||
    projection.terminalAt !== task.terminalAt ||
    governorDigest(projection as unknown as GovernorJsonValue) !== row.projection_digest
  ) {
    throw new Error("GOVERNOR_TASK_PROJECTION_BINDING_INVALID");
  }
  assertGovernorPersistedJson("log", task);
  assertOpaqueGovernorScope(task.scope, task.scopeKey);
  return task;
}

export function bindTask(task: GovernorTaskProjection): Insertable<GovernorTaskRow> {
  assertGovernorPersistedJson("log", task);
  assertOpaqueGovernorScope(task.scope, task.scopeKey);
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
    projection_digest: governorDigest(task as unknown as GovernorJsonValue),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    terminal_at: task.terminalAt ?? null,
  };
}

export function bindEvent(event: GovernorEventRecord): Insertable<GovernorEventRow> {
  assertGovernorPersistedJson("log", event);
  if (
    event.payloadDigest !== governorDigest(event.payload) ||
    !isOpaqueGovernorReference(event.scopeKey) ||
    (event.sourceMessageId !== undefined && !isOpaqueGovernorReference(event.sourceMessageId))
  ) {
    throw new Error("GOVERNOR_EVENT_BINDING_INVALID");
  }
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
    event_digest: governorDigest(event as unknown as GovernorJsonValue),
    created_at: event.createdAt,
  };
}

export function parseEventRow(row: GovernorEventRow): GovernorEventRecord {
  const event: GovernorEventRecord = {
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
    payload: parseGovernorStoredJson(row.payload_json, "log", "GOVERNOR_EVENT_PAYLOAD_INVALID"),
    payloadDigest: row.payload_digest,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
  };
  assertGovernorPersistedJson("log", event);
  if (
    event.payloadDigest !== governorDigest(event.payload) ||
    governorDigest(event as unknown as GovernorJsonValue) !== row.event_digest ||
    !isOpaqueGovernorReference(event.scopeKey) ||
    (event.sourceMessageId !== undefined && !isOpaqueGovernorReference(event.sourceMessageId))
  ) {
    throw new Error("GOVERNOR_EVENT_BINDING_INVALID");
  }
  return event;
}

export function bindEffect(effect: GovernorEffectRecord): Insertable<GovernorEffectRow> {
  assertGovernorPersistedJson("log", effect);
  if (!isOpaqueGovernorReference(effect.canonicalTarget)) {
    throw new Error("Governor effect target is not host-opaque");
  }
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
    effect_digest: governorDigest(effect as unknown as GovernorJsonValue),
    outcome_json: JSON.stringify(effect.outcome),
    verification_state: effect.verificationState,
    reconcile_required: effect.reconcileRequired ? 1 : 0,
    created_at: effect.createdAt,
    updated_at: effect.updatedAt,
  };
}

export function parseEffectRow(row: GovernorEffectRow): GovernorEffectRecord {
  const effect = parseGovernorStoredJson(
    row.effect_json,
    "log",
    "GOVERNOR_EFFECT_INVALID",
  ) as unknown as GovernorEffectRecord;
  const outcome = parseGovernorStoredJson(
    row.outcome_json,
    "log",
    "GOVERNOR_EFFECT_OUTCOME_INVALID",
  );
  if (
    effect.taskId !== row.task_id ||
    effect.effectId !== row.effect_id ||
    effect.idempotencyKey !== row.idempotency_key ||
    effect.taskVersion !== (normalizeSqliteNumber(row.task_version) ?? 0) ||
    effect.objectiveRevision !== (normalizeSqliteNumber(row.objective_revision) ?? 0) ||
    effect.planVersion !== (normalizeSqliteNumber(row.plan_version) ?? 0) ||
    effect.leaseEpoch !== (normalizeSqliteNumber(row.lease_epoch) ?? 0) ||
    effect.executionGeneration !== (normalizeSqliteNumber(row.execution_generation) ?? 0) ||
    effect.capability !== row.capability ||
    effect.canonicalTarget !== row.canonical_target ||
    effect.criterionId !== (row.criterion_id ?? undefined) ||
    effect.actionFingerprint !== row.action_fingerprint ||
    effect.progressVectorHash !== row.progress_vector_hash ||
    effect.mutating !== (normalizeSqliteNumber(row.mutating) === 1) ||
    effect.verificationState !== row.verification_state ||
    effect.reconcileRequired !== (normalizeSqliteNumber(row.reconcile_required) === 1) ||
    effect.createdAt !== (normalizeSqliteNumber(row.created_at) ?? 0) ||
    effect.updatedAt !== (normalizeSqliteNumber(row.updated_at) ?? 0) ||
    governorDigest(effect.outcome as unknown as GovernorJsonValue) !== governorDigest(outcome) ||
    governorDigest(effect as unknown as GovernorJsonValue) !== row.effect_digest
  ) {
    throw new Error("GOVERNOR_EFFECT_BINDING_INVALID");
  }
  assertGovernorPersistedJson("log", effect);
  if (!isOpaqueGovernorReference(effect.canonicalTarget)) {
    throw new Error("Persisted governor effect target is not host-opaque");
  }
  return effect;
}

export function bindEvidence(
  evidence: GovernorEvidenceRecord,
  assertVerified: (evidence: GovernorEvidenceRecord) => void,
): Insertable<GovernorEvidenceRow> {
  assertGovernorPersistedJson("log", evidence);
  if (!isOpaqueEvidenceSourceRef(evidence.sourceIdentity)) {
    throw new Error("Governor evidence source is not host-opaque");
  }
  assertVerified(evidence);
  if (governorDigest(evidence.payload) !== evidence.evidenceDigest) {
    throw new Error("Governor evidence payload digest mismatch");
  }
  if (
    governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
    evidence.semanticDigest
  ) {
    throw new Error("Governor evidence semantic digest mismatch");
  }
  return {
    evidence_id: evidence.evidenceId,
    task_id: evidence.taskId,
    criterion_id: evidence.criterionId,
    source_kind: evidence.sourceKind,
    source_identity: evidence.sourceIdentity,
    task_version: evidence.taskVersion,
    objective_revision: evidence.objectiveRevision,
    plan_version: evidence.planVersion,
    scope_key: evidence.scopeKey,
    observed_at: evidence.observedAt,
    evidence_digest: evidence.evidenceDigest,
    source_evidence_id: evidence.sourceEvidenceId ?? null,
    claim_predicate: evidence.predicate,
    claim_value_json: JSON.stringify(evidence.value),
    semantic_digest: evidence.semanticDigest,
    payload_json: JSON.stringify(evidence.payload),
    admissibility: evidence.admissibility,
    invalidated_at: evidence.invalidatedAt ?? null,
    created_at: evidence.createdAt,
    admission_key_id: evidence.admissionKeyId,
    admission_version: evidence.admissionVersion,
    admission_signature: evidence.admissionSignature,
  };
}

export function parseEvidenceRow(
  row: GovernorEvidenceRow,
  assertVerified: (evidence: GovernorEvidenceRecord) => void,
): GovernorEvidenceRecord {
  const value = parseGovernorStoredJson(
    row.claim_value_json,
    "log",
    "GOVERNOR_EVIDENCE_VALUE_INVALID",
  );
  const evidence: GovernorEvidenceRecord = {
    evidenceId: row.evidence_id,
    taskId: row.task_id as GovernorTaskId,
    criterionId: row.criterion_id,
    sourceKind: row.source_kind as GovernorEvidenceRecord["sourceKind"],
    sourceIdentity: row.source_identity as GovernorEvidenceRecord["sourceIdentity"],
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    scopeKey: row.scope_key,
    observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
    payload: parseGovernorStoredJson(row.payload_json, "log", "GOVERNOR_EVIDENCE_PAYLOAD_INVALID"),
    evidenceDigest: row.evidence_digest,
    ...(row.source_evidence_id == null ? {} : { sourceEvidenceId: row.source_evidence_id }),
    predicate: row.claim_predicate,
    value,
    semanticDigest: row.semantic_digest,
    admissibility: "admitted",
    ...(row.invalidated_at == null
      ? {}
      : { invalidatedAt: normalizeSqliteNumber(row.invalidated_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    admissionKeyId: row.admission_key_id,
    admissionVersion: normalizeSqliteNumber(row.admission_version) ?? 0,
    admissionSignature: row.admission_signature,
  };
  if (
    governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
    evidence.semanticDigest
  ) {
    throw new Error("GOVERNOR_EVIDENCE_SEMANTIC_DIGEST_INVALID");
  }
  if (governorDigest(evidence.payload) !== evidence.evidenceDigest) {
    throw new Error("GOVERNOR_EVIDENCE_PAYLOAD_DIGEST_INVALID");
  }
  assertVerified(evidence);
  assertGovernorPersistedJson("log", evidence);
  if (!isOpaqueEvidenceSourceRef(evidence.sourceIdentity)) {
    throw new Error("Persisted governor evidence source is not host-opaque");
  }
  return evidence;
}

export function governorDb(db: DatabaseSync) {
  return getNodeSqliteKysely<GovernorDatabase>(db);
}
