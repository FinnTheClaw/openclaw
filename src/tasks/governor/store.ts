// Persists governed task projections, immutable events, effects, evidence, and outbox intents.
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
import {
  bindGovernorActionIntent,
  GovernorActionIntentStore,
  type GovernorActionIntentUpdate,
} from "./action-intent-store.js";
import type { GovernorActionIntent } from "./action-intent.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { bindGovernorCheckpoint, GovernorCheckpointStore } from "./checkpoint-store.js";
import { assertValidGovernorContract } from "./contracts.js";
import { createGovernorEventRecord, type GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import {
  bindGovernorOutbox,
  GovernorOutboxStore,
  type GovernorOutboxRecord,
} from "./outbox-store.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  createGovernorTaskProjection,
  type GovernorEventId,
  type GovernorMode,
  type GovernorTaskContract,
  type GovernorTaskId,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

type GovernorDatabase = Pick<
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

export type GovernorIngressResult = {
  kind: "created" | "corrected" | "duplicate" | "stale";
  task: GovernorTaskProjection;
};

export type GovernorCommitResult =
  | { applied: true; task: GovernorTaskProjection }
  | {
      applied: false;
      reason: "not_found" | "task_version_conflict" | "lease_epoch_conflict";
      current?: GovernorTaskProjection;
    };

export type GovernorEffectUpdate = {
  current: GovernorEffectRecord;
  next: GovernorEffectRecord;
};

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid persisted governor ${label}`, { cause: error });
  }
}

function parseTaskRow(row: GovernorTaskRow): GovernorTaskProjection {
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

function bindTask(task: GovernorTaskProjection): Insertable<GovernorTaskRow> {
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

function bindEvent(event: GovernorEventRecord): Insertable<GovernorEventRow> {
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

function parseEventRow(row: GovernorEventRow): GovernorEventRecord {
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

function bindEffect(effect: GovernorEffectRecord): Insertable<GovernorEffectRow> {
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

function parseEffectRow(row: GovernorEffectRow): GovernorEffectRecord {
  const effect = parseJson<GovernorEffectRecord>(row.effect_json, "effect");
  if (effect.taskId !== row.task_id || effect.effectId !== row.effect_id) {
    throw new Error(`Persisted governor effect identity mismatch for ${row.effect_id}`);
  }
  return effect;
}

function bindEvidence(evidence: GovernorEvidenceRecord): Insertable<GovernorEvidenceRow> {
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

function parseEvidenceRow(row: GovernorEvidenceRow): GovernorEvidenceRecord {
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

function governorDb(db: DatabaseSync) {
  return getNodeSqliteKysely<GovernorDatabase>(db);
}

export class GovernorSqliteStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly actionIntents: GovernorActionIntentStore;
  readonly checkpoints: GovernorCheckpointStore;
  readonly outbox: GovernorOutboxStore;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    this.actionIntents = new GovernorActionIntentStore(params);
    this.checkpoints = new GovernorCheckpointStore(params);
    this.outbox = new GovernorOutboxStore(params);
  }

  #database() {
    return openOpenClawStateDatabase(this.#options);
  }

  #loadTaskFromDatabase(db: DatabaseSync, taskId: GovernorTaskId): GovernorTaskProjection | null {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db).selectFrom("governor_tasks").selectAll().where("task_id", "=", taskId),
    );
    return row ? parseTaskRow(row) : null;
  }

  loadTask(taskId: GovernorTaskId): GovernorTaskProjection | null {
    return this.#loadTaskFromDatabase(this.#database().db, taskId);
  }

  ingest(params: {
    eventId?: GovernorEventId;
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    mode: GovernorMode;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressResult {
    const contract = assertGovernorBoundarySafe(
      "session",
      params.contract as unknown as GovernorJsonValue,
    ) as unknown as GovernorTaskContract;
    assertValidGovernorContract(contract);
    if (!params.sourceMessageId.trim()) {
      throw new Error("sourceMessageId must not be empty");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const dbx = governorDb(db);
      const incoming = createGovernorTaskProjection({
        scope: params.scope,
        mode: params.mode,
        contract,
        authenticatedSourceSequence: params.sourceSequence,
        flowId: params.flowId,
        now: params.now,
      });
      const duplicate = executeSqliteQueryTakeFirstSync(
        db,
        dbx
          .selectFrom("governor_events")
          .select(["task_id"])
          .where("scope_key", "=", incoming.scopeKey)
          .where("source_message_id", "=", params.sourceMessageId),
      );
      if (duplicate) {
        const task = this.#loadTaskFromDatabase(db, duplicate.task_id as GovernorTaskId);
        if (!task) {
          throw new Error(`Governor ingress event references missing task ${duplicate.task_id}`);
        }
        return { kind: "duplicate", task };
      }
      const activeRow = executeSqliteQueryTakeFirstSync(
        db,
        dbx
          .selectFrom("governor_tasks")
          .selectAll()
          .where("scope_key", "=", incoming.scopeKey)
          .where("terminal_at", "is", null)
          .orderBy("updated_at", "desc")
          .orderBy("task_id", "asc")
          .limit(1),
      );
      if (!activeRow) {
        executeSqliteQuerySync(db, dbx.insertInto("governor_tasks").values(bindTask(incoming)));
        const event = createGovernorEventRecord({
          task: incoming,
          eventId: params.eventId,
          eventType: "task_received",
          sourceMessageId: params.sourceMessageId,
          sourceSequence: params.sourceSequence,
          payload: { mode: params.mode },
          now: params.now,
        });
        executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
        return { kind: "created", task: incoming };
      }
      const current = parseTaskRow(activeRow);
      if (params.sourceSequence <= current.authenticatedSourceSequence) {
        const event = createGovernorEventRecord({
          task: current,
          eventId: params.eventId,
          eventType: "stale_ingress_ignored",
          sourceMessageId: params.sourceMessageId,
          sourceSequence: params.sourceSequence,
          payload: { authoritativeSequence: current.authenticatedSourceSequence },
          now: params.now,
        });
        executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
        return { kind: "stale", task: current };
      }
      const corrected: GovernorTaskProjection = {
        ...current,
        mode: params.mode,
        contract,
        plan: undefined,
        state:
          current.state === "RECEIVED" || current.state === "CONTRACTING"
            ? "CONTRACTING"
            : "REPLAN_REQUIRED",
        taskVersion: current.taskVersion + 1,
        objectiveRevision: current.objectiveRevision + 1,
        planVersion: current.planVersion + 1,
        executionGeneration: current.executionGeneration + 1,
        authenticatedSourceSequence: params.sourceSequence,
        updatedAt: params.now,
      };
      const update = executeSqliteQuerySync(
        db,
        dbx
          .updateTable("governor_tasks")
          .set(bindTask(corrected))
          .where("task_id", "=", current.taskId)
          .where("task_version", "=", current.taskVersion)
          .where("lease_epoch", "=", current.leaseEpoch),
      );
      if (update.numAffectedRows !== 1n) {
        throw new Error(`Concurrent governor correction for ${current.taskId}`);
      }
      const event = createGovernorEventRecord({
        task: corrected,
        eventId: params.eventId,
        eventType: "task_corrected",
        sourceMessageId: params.sourceMessageId,
        sourceSequence: params.sourceSequence,
        payload: { previousObjectiveRevision: current.objectiveRevision },
        now: params.now,
      });
      executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
      return { kind: "corrected", task: corrected };
    }, this.#options);
  }

  commit(params: {
    current: GovernorTaskProjection;
    next: GovernorTaskProjection;
    event: GovernorEventRecord;
    effects?: readonly GovernorEffectRecord[];
    effectUpdates?: readonly GovernorEffectUpdate[];
    actionIntents?: readonly GovernorActionIntent[];
    actionIntentUpdates?: readonly GovernorActionIntentUpdate[];
    checkpoints?: readonly GovernorCheckpoint[];
    evidence?: readonly GovernorEvidenceRecord[];
    outbox?: readonly GovernorOutboxRecord[];
  }): GovernorCommitResult {
    if (
      params.next.taskId !== params.current.taskId ||
      params.next.scopeKey !== params.current.scopeKey ||
      params.next.taskVersion !== params.current.taskVersion + 1 ||
      params.next.leaseEpoch < params.current.leaseEpoch ||
      params.next.leaseEpoch > params.current.leaseEpoch + 1 ||
      params.event.taskId !== params.next.taskId ||
      params.event.taskVersion !== params.next.taskVersion ||
      params.event.objectiveRevision !== params.next.objectiveRevision ||
      params.event.payloadDigest !== governorDigest(params.event.payload)
    ) {
      throw new Error(`Invalid governor commit envelope for ${params.current.taskId}`);
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const stored = this.#loadTaskFromDatabase(db, params.current.taskId);
      if (!stored) {
        return { applied: false, reason: "not_found" };
      }
      if (stored.taskVersion !== params.current.taskVersion) {
        return { applied: false, reason: "task_version_conflict", current: stored };
      }
      if (stored.leaseEpoch !== params.current.leaseEpoch) {
        return { applied: false, reason: "lease_epoch_conflict", current: stored };
      }
      const dbx = governorDb(db);
      const update = executeSqliteQuerySync(
        db,
        dbx
          .updateTable("governor_tasks")
          .set(bindTask(params.next))
          .where("task_id", "=", params.current.taskId)
          .where("task_version", "=", params.current.taskVersion)
          .where("lease_epoch", "=", params.current.leaseEpoch),
      );
      if (update.numAffectedRows !== 1n) {
        const current = this.#loadTaskFromDatabase(db, params.current.taskId) ?? undefined;
        return { applied: false, reason: "task_version_conflict", current };
      }
      executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(params.event)));
      for (const intent of params.actionIntents ?? []) {
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_action_intents")
            .values(bindGovernorActionIntent(intent))
            .onConflict((conflict) => conflict.columns(["task_id", "effect_id"]).doNothing()),
        );
      }
      for (const intentUpdate of params.actionIntentUpdates ?? []) {
        if (
          intentUpdate.current.taskId !== params.current.taskId ||
          intentUpdate.next.taskId !== intentUpdate.current.taskId ||
          intentUpdate.next.effectId !== intentUpdate.current.effectId ||
          intentUpdate.next.objectiveRevision !== params.next.objectiveRevision ||
          intentUpdate.next.updatedAt < intentUpdate.current.updatedAt
        ) {
          throw new Error(`Invalid governor action intent update ${intentUpdate.current.effectId}`);
        }
        const actionUpdate = executeSqliteQuerySync(
          db,
          dbx
            .updateTable("governor_action_intents")
            .set(bindGovernorActionIntent(intentUpdate.next))
            .where("task_id", "=", intentUpdate.current.taskId)
            .where("effect_id", "=", intentUpdate.current.effectId)
            .where("updated_at", "=", intentUpdate.current.updatedAt),
        );
        if (actionUpdate.numAffectedRows !== 1n) {
          throw new Error(
            `Concurrent governor action intent update ${intentUpdate.current.effectId}`,
          );
        }
      }
      for (const checkpoint of params.checkpoints ?? []) {
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_checkpoints")
            .values(bindGovernorCheckpoint(checkpoint))
            .onConflict((conflict) => conflict.column("checkpoint_id").doNothing()),
        );
      }
      for (const effect of params.effects ?? []) {
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_effects")
            .values(bindEffect(effect))
            .onConflict((conflict) => conflict.columns(["task_id", "effect_id"]).doNothing()),
        );
      }
      for (const effectUpdate of params.effectUpdates ?? []) {
        if (
          effectUpdate.current.taskId !== params.current.taskId ||
          effectUpdate.next.taskId !== effectUpdate.current.taskId ||
          effectUpdate.next.effectId !== effectUpdate.current.effectId ||
          effectUpdate.next.objectiveRevision !== params.next.objectiveRevision ||
          effectUpdate.next.updatedAt < effectUpdate.current.updatedAt
        ) {
          throw new Error(`Invalid governor effect update ${effectUpdate.current.effectId}`);
        }
        const effectUpdateResult = executeSqliteQuerySync(
          db,
          dbx
            .updateTable("governor_effects")
            .set(bindEffect(effectUpdate.next))
            .where("task_id", "=", effectUpdate.current.taskId)
            .where("effect_id", "=", effectUpdate.current.effectId)
            .where("updated_at", "=", effectUpdate.current.updatedAt),
        );
        if (effectUpdateResult.numAffectedRows !== 1n) {
          throw new Error(`Concurrent governor effect update ${effectUpdate.current.effectId}`);
        }
      }
      for (const evidence of params.evidence ?? []) {
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_evidence")
            .values(bindEvidence(evidence))
            .onConflict((conflict) => conflict.column("evidence_id").doNothing()),
        );
      }
      for (const outbox of params.outbox ?? []) {
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_outbox")
            .values(bindGovernorOutbox(outbox))
            .onConflict((conflict) => conflict.columns(["task_id", "effect_id"]).doNothing()),
        );
      }
      return { applied: true, task: params.next };
    }, this.#options);
  }

  appendAuditEvent(params: { task: GovernorTaskProjection; event: GovernorEventRecord }): boolean {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = this.#loadTaskFromDatabase(db, params.task.taskId);
      if (
        !current ||
        current.taskVersion !== params.task.taskVersion ||
        current.leaseEpoch !== params.task.leaseEpoch ||
        params.event.taskId !== current.taskId ||
        params.event.taskVersion !== current.taskVersion ||
        params.event.objectiveRevision !== current.objectiveRevision ||
        params.event.payloadDigest !== governorDigest(params.event.payload)
      ) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        governorDb(db).insertInto("governor_events").values(bindEvent(params.event)),
      );
      return true;
    }, this.#options);
  }

  listEvents(taskId: GovernorTaskId): GovernorEventRecord[] {
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_events")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("event_id", "asc"),
    ).rows.map(parseEventRow);
  }

  listEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseEffectRow);
  }

  loadEffect(taskId: GovernorTaskId, effectId: string): GovernorEffectRecord | null {
    const { db } = this.#database();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("effect_id", "=", effectId),
    );
    return row ? parseEffectRow(row) : null;
  }

  listEvidence(taskId: GovernorTaskId): GovernorEvidenceRecord[] {
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("evidence_id", "asc"),
    ).rows.map(parseEvidenceRow);
  }

  listUnfinishedFanoutJobIds(taskId: GovernorTaskId): string[] {
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_fanout_jobs")
        .select(["job_id"])
        .where("task_id", "=", taskId)
        .where("state", "in", ["queued", "running"])
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows.map((row) => row.job_id);
  }
}
