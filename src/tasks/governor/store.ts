// Persists governed task projections, immutable events, effects, evidence, and outbox intents.
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { HostGovernorDeliveryHandle } from "../../security/governor-host-readonly.js";
import type { HostDeliveryReceipt } from "../../security/governor-host-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { bindGovernorActionIntent } from "./action-intent-codec.js";
import {
  GovernorActionIntentStore,
  type GovernorActionIntentUpdate,
} from "./action-intent-store.js";
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
import {
  bindGovernorOutbox,
  GovernorOutboxStore,
  type GovernorOutboxRecord,
} from "./outbox-store.js";
import { assertGovernorPersistedJson, assertSameGovernorScope } from "./persistence-guard.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { appendGovernorAuditEvent } from "./store-audit.js";
import {
  createGovernorStoreDependencies,
  type GovernorSqliteStoreParams,
} from "./store-bootstrap.js";
import { bindEffect, bindEvent, bindEvidence, bindTask, governorDb } from "./store-codec.js";
import {
  GovernorEvidenceAdmissionStore,
  type GovernorPendingEvidence,
} from "./store-evidence-admission.js";
import { ingestGovernorTask, type GovernorIngressResult } from "./store-ingress.js";
import { GovernorStoreQueries, loadGovernorTask } from "./store-queries.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  isOpaqueGovernorReference,
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

export type { GovernorIngressResult } from "./store-ingress.js";

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

  constructor(params: GovernorSqliteStoreParams = {}) {
    const dependencies = createGovernorStoreDependencies(params);
    this.#options = dependencies.options;
    this.identity = dependencies.identity;
    this.#evidenceAdmissions = dependencies.evidenceAdmissions;
    this.#queries = dependencies.queries;
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
      throw new Error(`Governor action intent approval policy mismatch ${intent.effectId}`);
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
    return ingestGovernorTask({ options: this.#options, identity: this.identity, ingress: params });
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
    assertGovernorPersistedJson("log", {
      current: params.current,
      next: params.next,
      event: params.event,
      effects: [...(params.effects ?? [])],
      effectUpdates: [...(params.effectUpdates ?? [])],
      actionIntents: [...(params.actionIntents ?? [])],
      actionIntentUpdates: [...(params.actionIntentUpdates ?? [])],
      checkpoints: [...(params.checkpoints ?? [])],
      evidence: params.evidenceAdmission?.evidence ?? null,
      outbox: [...(params.outbox ?? [])],
    });
    assertSameGovernorScope(params.current, params.current);
    assertSameGovernorScope(params.current, params.next);
    if (
      params.next.taskId !== params.current.taskId ||
      params.next.scopeKey !== params.current.scopeKey ||
      params.next.taskVersion !== params.current.taskVersion + 1 ||
      params.next.leaseEpoch < params.current.leaseEpoch ||
      params.next.leaseEpoch > params.current.leaseEpoch + 1 ||
      params.event.taskId !== params.next.taskId ||
      params.event.scopeKey !== params.next.scopeKey ||
      params.event.taskVersion !== params.next.taskVersion ||
      params.event.objectiveRevision !== params.next.objectiveRevision ||
      (params.next.flowId !== undefined && !isOpaqueGovernorReference(params.next.flowId)) ||
      (params.event.sourceMessageId !== undefined &&
        !isOpaqueGovernorReference(params.event.sourceMessageId)) ||
      params.event.payloadDigest !== governorDigest(params.event.payload)
    ) {
      throw new Error(`Invalid governor commit envelope for ${params.current.taskId}`);
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const stored = loadGovernorTask(db, params.current.taskId);
      if (!stored) {
        return { applied: false, reason: "not_found" };
      }
      assertSameGovernorScope(stored, params.current);
      assertSameGovernorScope(stored, params.next);
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
