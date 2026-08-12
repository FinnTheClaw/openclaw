// Persists governed task projections, immutable events, effects, evidence, and outbox intents.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { HostGovernorDeliveryHandle } from "../../security/governor-host-readonly.js";
import type { HostDeliveryReceipt } from "../../security/governor-host-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { bindGovernorActionIntent } from "./action-intent-codec.js";
import { GovernorActionIntentStore } from "./action-intent-store.js";
import type { GovernorActionIntent } from "./action-intent.js";
import { GovernorApprovalGrantStore } from "./approval-store.js";
import { governorDigest } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { bindGovernorCheckpoint, GovernorCheckpointStore } from "./checkpoint-store.js";
import { GovernorDeliveryCertificationStore } from "./delivery-certification-store.js";
import type { GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceCandidate, GovernorEvidenceRecord } from "./evidence.js";
import { GovernorExternalChildRunStore } from "./external-child-runs.js";
import { GovernorFanoutStore } from "./fanout.js";
import { GovernorMemorySubsystem } from "./memory-subsystem.js";
import { bindGovernorOutbox, GovernorOutboxStore } from "./outbox-store.js";
import { assertGovernorPersistedJson, assertSameGovernorScope } from "./persistence-guard.js";
import type { GovernorWorkProfile } from "./planning-policy.js";
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
  type GovernorCommitPayload,
  validateGovernorCommitPayload,
} from "./store-commit-validation.js";
import {
  GovernorEvidenceAdmissionStore,
  type GovernorPendingEvidence,
} from "./store-evidence-admission.js";
import { ingestGovernorTask, type GovernorIngressResult } from "./store-ingress.js";
import { GovernorStoreQueries, loadGovernorTask } from "./store-queries.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  opaqueGovernorReference,
  type GovernorEventId,
  type GovernorIdentityContext,
  type GovernorMode,
  type GovernorTaskContract,
  type GovernorTaskId,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";
import { assertGovernorTaskClassification } from "./work-classification.js";

export type { GovernorStoreSecrets } from "./store-bootstrap.js";

export type { GovernorIngressResult } from "./store-ingress.js";

// oxfmt-ignore
export type GovernorCommitResult = { applied: true; task: GovernorTaskProjection } | { applied: false; reason: "not_found" | "task_version_conflict" | "lease_epoch_conflict"; current?: GovernorTaskProjection };

export type { GovernorEffectUpdate } from "./store-commit-validation.js";
export type { GovernorPendingEvidence } from "./store-evidence-admission.js";

function runRecoverableTaskWrite(
  options: OpenClawStateDatabaseOptions,
  tasks: GovernorTaskAuthorityStore,
  operation: (database: OpenClawStateDatabase) => GovernorCommitResult,
): GovernorCommitResult {
  let result: GovernorCommitResult;
  try {
    result = runOpenClawStateWriteTransaction(operation, options);
  } catch (error) {
    runOpenClawStateWriteTransaction(({ db }) => tasks.reconcilePrimary(db), options);
    throw error;
  }
  if (!result.applied) {
    runOpenClawStateWriteTransaction(({ db }) => tasks.reconcilePrimary(db), options);
  }
  return result;
}

export class GovernorSqliteStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly identity: GovernorIdentityContext;
  readonly actionIntents: GovernorActionIntentStore;
  readonly capabilities: GovernorCapabilityRegistry;
  readonly #approvals: GovernorApprovalGrantStore;
  readonly #deliveryCertifications: GovernorDeliveryCertificationStore;
  readonly checkpoints: GovernorCheckpointStore;
  readonly memory: GovernorMemorySubsystem;
  readonly fanout: GovernorFanoutStore;
  readonly children: GovernorExternalChildRunStore;
  readonly outbox: GovernorOutboxStore;
  readonly #evidenceAdmissions: GovernorEvidenceAdmissionStore;
  readonly #queries: GovernorStoreQueries;
  readonly #tasks: GovernorTaskAuthorityStore;

  constructor(params: GovernorSqliteStoreParams = {}) {
    const dependencies = createGovernorStoreDependencies(params);
    this.#options = dependencies.options;
    this.identity = dependencies.identity;
    this.#evidenceAdmissions = dependencies.evidenceAdmissions;
    this.#queries = dependencies.queries;
    this.#tasks = dependencies.tasks;
    this.actionIntents = dependencies.actionIntents;
    this.capabilities = dependencies.capabilities;
    this.#approvals = dependencies.approvals;
    this.#deliveryCertifications = dependencies.deliveryCertifications;
    this.checkpoints = dependencies.checkpoints;
    this.memory = dependencies.memory;
    this.fanout = dependencies.fanout;
    this.children = dependencies.children;
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

  verifyCertifiedDeliveryReceipt(receipt: HostDeliveryReceipt) {
    return this.#deliveryCertifications.verifyReceipt(receipt);
  }

  #assertActionIntentPolicy(task: GovernorTaskProjection, intent: GovernorActionIntent): void {
    this.capabilities.assertPersistedIntentAuthorized(task, intent.proposal, this.identity);
    const policy = this.capabilities.approvalPolicy(intent.proposal);
    if (
      intent.approvalRequired !== policy.required ||
      intent.approvalPolicyDigest !== policy.digest
    ) {
      throw new Error("GOVERNOR_ACTION_POLICY_BINDING_INVALID");
    }
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
    assertGovernorPersistedJson("log", params.candidate);
    return this.#evidenceAdmissions.admit(params);
  }

  // oxfmt-ignore
  loadTask(taskId: GovernorTaskId): GovernorTaskProjection | null { return loadGovernorTask(this.#database().db, taskId, this.#tasks); }

  ingest(params: {
    eventId?: GovernorEventId;
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    mode?: GovernorMode;
    profile?: GovernorWorkProfile;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressResult {
    return ingestGovernorTask({
      options: this.#options,
      identity: this.identity,
      capabilities: this.capabilities,
      tasks: this.#tasks,
      ingress: params,
    });
  }

  commit(params: GovernorCommitPayload): GovernorCommitResult {
    assertGovernorTaskClassification(params.current, this.capabilities);
    assertGovernorTaskClassification(params.next, this.capabilities);
    if (
      governorDigest(
        params.current.contract as unknown as import("./canonical-json.js").GovernorJsonValue,
      ) !==
        governorDigest(
          params.next.contract as unknown as import("./canonical-json.js").GovernorJsonValue,
        ) ||
      governorDigest(
        params.current.classification as unknown as import("./canonical-json.js").GovernorJsonValue,
      ) !==
        governorDigest(
          params.next.classification as unknown as import("./canonical-json.js").GovernorJsonValue,
        )
    ) {
      throw new Error("GOVERNOR_WORK_CLASSIFICATION_CHANGED_OUTSIDE_INGRESS");
    }
    validateGovernorCommitPayload(params, {
      assertActionIntentPolicy: (task, intent) => this.#assertActionIntentPolicy(task, intent),
      ownsEvidence: (pending) => this.#evidenceAdmissions.owns(pending),
      verifyEvidence: (evidence) => this.#evidenceAdmissions.verify(evidence),
    });
    const result = runRecoverableTaskWrite(this.#options, this.#tasks, ({ db }) => {
      this.#tasks.reconcilePrimary(db);
      const dbx = governorDb(db);
      const storedRow = executeSqliteQueryTakeFirstSync(
        db,
        dbx.selectFrom("governor_tasks").selectAll().where("task_id", "=", params.current.taskId),
      );
      if (!storedRow) {
        return { applied: false, reason: "not_found" };
      }
      const stored = parseTaskRow(storedRow);
      assertSameGovernorScope(stored, params.current);
      assertSameGovernorScope(stored, params.next);
      if (
        stored.taskVersion !== params.current.taskVersion ||
        governorDigest(stored as unknown as import("./canonical-json.js").GovernorJsonValue) !==
          governorDigest(
            params.current as unknown as import("./canonical-json.js").GovernorJsonValue,
          )
      ) {
        return { applied: false, reason: "task_version_conflict", current: stored };
      }
      if (stored.leaseEpoch !== params.current.leaseEpoch) {
        return { applied: false, reason: "lease_epoch_conflict", current: stored };
      }
      this.#tasks.prepare(params.next);
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
        const current = loadGovernorTask(db, params.current.taskId, this.#tasks) ?? undefined;
        return { applied: false, reason: "task_version_conflict", current };
      }
      executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(params.event)));
      for (const intent of params.actionIntents ?? []) {
        if (
          intent.taskId !== params.next.taskId ||
          intent.objectiveRevision !== params.next.objectiveRevision ||
          intent.planVersion !== params.next.planVersion ||
          intent.leaseEpoch !== params.next.leaseEpoch ||
          intent.executionGeneration !== params.next.executionGeneration ||
          intent.taskVersion < params.current.taskVersion ||
          intent.taskVersion > params.next.taskVersion
        ) {
          throw new Error("GOVERNOR_ACTION_INTENT_TASK_BINDING_INVALID");
        }
        this.#assertActionIntentPolicy(params.next, intent);
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_action_intents")
            .values(bindGovernorActionIntent(intent))
            .onConflict((conflict) => conflict.columns(["task_id", "effect_id"]).doNothing()),
        );
      }
      for (const intentUpdate of params.actionIntentUpdates ?? []) {
        this.#assertActionIntentPolicy(params.next, intentUpdate.next);
        if (
          intentUpdate.current.taskId !== params.current.taskId ||
          intentUpdate.next.taskId !== intentUpdate.current.taskId ||
          intentUpdate.next.effectId !== intentUpdate.current.effectId ||
          intentUpdate.next.objectiveRevision !== params.next.objectiveRevision ||
          intentUpdate.next.updatedAt < intentUpdate.current.updatedAt
        ) {
          throw new Error("GOVERNOR_ACTION_INTENT_UPDATE_INVALID");
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
          throw new Error("GOVERNOR_ACTION_INTENT_UPDATE_CONFLICT");
        }
      }
      for (const checkpoint of params.checkpoints ?? []) {
        if (
          checkpoint.taskId !== params.next.taskId ||
          checkpoint.objectiveRevision !== params.next.objectiveRevision ||
          checkpoint.planVersion !== params.next.planVersion ||
          checkpoint.taskVersion !== params.next.taskVersion
        ) {
          throw new Error("GOVERNOR_CHECKPOINT_TASK_BINDING_INVALID");
        }
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_checkpoints")
            .values(bindGovernorCheckpoint(checkpoint))
            .onConflict((conflict) => conflict.column("checkpoint_id").doNothing()),
        );
      }
      for (const effect of params.effects ?? []) {
        if (
          effect.taskId !== params.next.taskId ||
          effect.objectiveRevision !== params.next.objectiveRevision ||
          effect.planVersion !== params.next.planVersion ||
          effect.leaseEpoch !== params.next.leaseEpoch ||
          effect.executionGeneration !== params.next.executionGeneration ||
          effect.taskVersion < params.current.taskVersion ||
          effect.taskVersion > params.next.taskVersion
        ) {
          throw new Error("GOVERNOR_EFFECT_TASK_BINDING_INVALID");
        }
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
          throw new Error("GOVERNOR_EFFECT_UPDATE_INVALID");
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
          throw new Error("GOVERNOR_EFFECT_UPDATE_CONFLICT");
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
        if (
          outbox.taskId !== params.next.taskId ||
          outbox.taskVersion !== params.next.taskVersion ||
          outbox.objectiveRevision !== params.next.objectiveRevision ||
          outbox.planVersion !== params.next.planVersion ||
          outbox.leaseEpoch !== params.next.leaseEpoch ||
          outbox.executionGeneration !== params.next.executionGeneration
        ) {
          throw new Error("GOVERNOR_OUTBOX_TASK_BINDING_INVALID");
        }
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_outbox")
            .values(bindGovernorOutbox(outbox))
            .onConflict((conflict) => conflict.columns(["task_id", "effect_id"]).doNothing()),
        );
      }
      return { applied: true, task: params.next };
    });
    if (result.applied) {
      this.#tasks.finalize(result.task);
    }
    return result;
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

  listCurrentEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    return this.#queries.listCurrentEffects(taskId);
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
