// Persists governed task projections, immutable events, effects, evidence, and outbox intents.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { HostGovernorDeliveryHandle } from "../../security/governor-host-readonly.js";
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
import { GovernorApprovalGrantStore } from "./approval-store.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { bindGovernorCheckpoint, GovernorCheckpointStore } from "./checkpoint-store.js";
import { assertValidGovernorContract } from "./contracts.js";
import { GovernorDeliveryCertificationStore } from "./delivery-certification-store.js";
import { createGovernorEventRecord, type GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceCandidate, GovernorEvidenceRecord } from "./evidence.js";
import { GovernorMemorySubsystem } from "./memory-subsystem.js";
import {
  bindGovernorOutbox,
  GovernorOutboxStore,
  type GovernorOutboxRecord,
} from "./outbox-store.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { appendGovernorAuditEvent } from "./store-audit.js";
import {
  createGovernorStoreDependencies,
  type GovernorSqliteStoreParams,
} from "./store-bootstrap.js";
import {
  bindEffect,
  bindEvent,
  bindEvidence,
  bindTask,
  governorDb,
  parseTaskRow,
} from "./store-codec.js";
import {
  GovernorEvidenceAdmissionStore,
  type GovernorPendingEvidence,
} from "./store-evidence-admission.js";
import { GovernorStoreQueries, loadGovernorTask } from "./store-queries.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  createGovernorTaskProjection,
  opaqueGovernorReference,
  type GovernorEventId,
  type GovernorIdentityContext,
  type GovernorMode,
  type GovernorTaskContract,
  type GovernorTaskId,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

export type { GovernorStoreSecrets } from "./store-bootstrap.js";

export type GovernorIngressResult = {
  kind: "created" | "corrected" | "duplicate" | "stale";
  task: GovernorTaskProjection;
};

// oxfmt-ignore
export type GovernorCommitResult = { applied: true; task: GovernorTaskProjection } | { applied: false; reason: "not_found" | "task_version_conflict" | "lease_epoch_conflict"; current?: GovernorTaskProjection };

export type GovernorEffectUpdate = {
  current: GovernorEffectRecord;
  next: GovernorEffectRecord;
};
export type { GovernorPendingEvidence } from "./store-evidence-admission.js";

export class GovernorSqliteStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly identity: GovernorIdentityContext;
  readonly actionIntents: GovernorActionIntentStore;
  readonly #approvals: GovernorApprovalGrantStore;
  readonly #deliveryCertifications: GovernorDeliveryCertificationStore;
  readonly checkpoints: GovernorCheckpointStore;
  readonly memory: GovernorMemorySubsystem;
  readonly outbox: GovernorOutboxStore;
  readonly #evidenceAdmissions: GovernorEvidenceAdmissionStore;
  readonly #queries: GovernorStoreQueries;

  constructor(params: GovernorSqliteStoreParams = {}) {
    const dependencies = createGovernorStoreDependencies(params);
    this.#options = dependencies.options;
    this.identity = dependencies.identity;
    this.#evidenceAdmissions = dependencies.evidenceAdmissions;
    this.#queries = dependencies.queries;
    this.actionIntents = dependencies.actionIntents;
    this.#approvals = dependencies.approvals;
    this.#deliveryCertifications = dependencies.deliveryCertifications;
    this.checkpoints = dependencies.checkpoints;
    this.memory = dependencies.memory;
    this.outbox = dependencies.outbox;
  }

  opaqueReference(kind: string, value: string): string {
    return opaqueGovernorReference(kind, value, this.identity);
  }

  #database() {
    return openOpenClawStateDatabase(this.#options);
  }

  approvalStatus(
    task: GovernorTaskProjection,
    proposal: import("./tool-outcome.js").GovernorActionProposal,
    now: number,
  ) {
    return this.#approvals.status(task, proposal, now);
  }

  /** Delivery work resolves only through the host-broker-bound handle registry. */
  resolveCertifiedDelivery(handle: HostGovernorDeliveryHandle) {
    return this.#deliveryCertifications.resolveCertified(handle);
  }

  /** Host integrations pass only a broker-issued opaque approval receipt. */
  admitAuthenticatedApproval(params: {
    task: GovernorTaskProjection;
    receiptId: import("../../security/governor-host-readonly.js").HostGovernorApprovalReceiptId;
    now: number;
  }): string {
    return this.#approvals.admitAuthenticatedApproval(params);
  }

  /** Host integrations pass only a broker-issued opaque revocation receipt. */
  applyAuthenticatedApprovalRevocation(params: {
    grantId: string;
    receiptId: import("../../security/governor-host-readonly.js").HostGovernorApprovalRevocationId;
  }): boolean {
    return this.#approvals.applyAuthenticatedRevocation(params);
  }

  admitEvidenceCandidate(params: {
    task: GovernorTaskProjection;
    candidate: GovernorEvidenceCandidate;
    receiptId?: string;
    now: number;
  }): GovernorPendingEvidence {
    return this.#evidenceAdmissions.admit(params);
  }

  // oxfmt-ignore
  loadTask(taskId: GovernorTaskId): GovernorTaskProjection | null { return loadGovernorTask(this.#database().db, taskId); }

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
        identity: this.identity,
      });
      const sourceMessageId = opaqueGovernorReference(
        `source-message:${incoming.scopeKey}`,
        params.sourceMessageId,
        this.identity,
      );
      const duplicate = executeSqliteQueryTakeFirstSync(
        db,
        dbx
          .selectFrom("governor_events")
          .select(["task_id"])
          .where("scope_key", "=", incoming.scopeKey)
          .where("source_message_id", "=", sourceMessageId),
      );
      if (duplicate) {
        const task = loadGovernorTask(db, duplicate.task_id as GovernorTaskId);
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
          sourceMessageId,
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
          sourceMessageId,
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
        conditions: { contradictions: [], pendingUserUpdate: false },
        claims: [],
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
      // A correction invalidates all old workers before the new revision can plan or finish.
      executeSqliteQuerySync(
        db,
        dbx
          .updateTable("governor_action_intents")
          .set({ state: "cancelled", cancelled_at: params.now, updated_at: params.now })
          .where("task_id", "=", current.taskId)
          .where("execution_generation", "!=", corrected.executionGeneration)
          .where("state", "in", ["admitted", "running"]),
      );
      executeSqliteQuerySync(
        db,
        dbx
          .updateTable("governor_fanout_jobs")
          .set({
            state: "cancelled",
            cancelled_at: params.now,
            worker_id: null,
            lease_expires_at: null,
            updated_at: params.now,
          })
          .where("task_id", "=", current.taskId)
          .where("execution_generation", "!=", corrected.executionGeneration)
          .where("state", "in", ["queued", "running"]),
      );
      const event = createGovernorEventRecord({
        task: corrected,
        eventId: params.eventId,
        eventType: "task_corrected",
        sourceMessageId,
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
    evidenceAdmission?: GovernorPendingEvidence;
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
      const stored = loadGovernorTask(db, params.current.taskId);
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
        const current = loadGovernorTask(db, params.current.taskId) ?? undefined;
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
      if (params.evidenceAdmission) {
        if (!this.#evidenceAdmissions.owns(params.evidenceAdmission)) {
          throw new Error("Governor evidence admission was not created by this store");
        }
        const evidence = params.evidenceAdmission.evidence;
        if (
          evidence.taskId !== params.current.taskId ||
          evidence.scopeKey !== params.current.scopeKey ||
          evidence.objectiveRevision !== params.next.objectiveRevision ||
          evidence.planVersion !== params.next.planVersion ||
          evidence.taskVersion > params.current.taskVersion
        ) {
          throw new Error("Governor evidence admission is stale or task-bound incorrectly");
        }
        this.#evidenceAdmissions.verify(evidence);
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_evidence")
            .values(bindEvidence(evidence, (item) => this.#evidenceAdmissions.verify(item)))
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
    return appendGovernorAuditEvent({ options: this.#options, ...params });
  }

  listEvents(taskId: GovernorTaskId): GovernorEventRecord[] {
    return this.#queries.listEvents(taskId);
  }

  listEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    return this.#queries.listEffects(taskId);
  }

  loadEffect(taskId: GovernorTaskId, effectId: string): GovernorEffectRecord | null {
    return this.#queries.loadEffect(taskId, effectId);
  }

  listEvidence(taskId: GovernorTaskId): GovernorEvidenceRecord[] {
    return this.#queries.listEvidence(taskId);
  }

  listUnfinishedFanoutJobIds(task: GovernorTaskProjection): string[] {
    return this.#queries.listUnfinishedFanoutJobIds(task);
  }
}
