// Persists governed task projections, immutable events, effects, evidence, and outbox intents.
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  createHostGovernorBroker,
  isTrustedGovernorReceiptResolver,
  type HostGovernorCapabilities,
  type GovernorTrustedReceiptResolver,
  type HostGovernorReceiptId,
} from "../../security/governor-host-broker.js";
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
import { canonicalGovernorJson, governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { bindGovernorCheckpoint, GovernorCheckpointStore } from "./checkpoint-store.js";
import { assertValidGovernorContract } from "./contracts.js";
import { GovernorDeliveryCertificationStore } from "./delivery-certification-store.js";
import { createGovernorEventRecord, type GovernorEventRecord } from "./events.js";
import {
  assertOpaqueEvidenceSourceRef,
  createGovernorEvidenceCandidate,
  deriveGovernorEvidenceSemantics,
  governorEvidenceAdmissionPayload,
  opaqueEvidenceSourceRef,
  validateGovernorEvidenceCandidate,
  type GovernorEvidenceCandidate,
  type GovernorEvidenceRecord,
} from "./evidence.js";
import {
  bindGovernorOutbox,
  GovernorOutboxStore,
  type GovernorOutboxRecord,
} from "./outbox-store.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import {
  bindEffect,
  bindEvent,
  bindEvidence,
  bindTask,
  governorDb,
  parseEffectRow,
  parseEventRow,
  parseEvidenceRow,
  parseTaskRow,
} from "./store-codec.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import {
  assertGovernorIdentityHmacKeyAvailable,
  createGovernorTaskProjection,
  opaqueGovernorReference,
  type GovernorEventId,
  type GovernorMode,
  type GovernorTaskContract,
  type GovernorTaskId,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

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

declare const governorPendingEvidenceBrand: unique symbol;

/** Opaque, store-bound admission.  It cannot be manufactured from data. */
export type GovernorPendingEvidence = {
  readonly evidence: GovernorEvidenceRecord;
  readonly [governorPendingEvidenceBrand]: object;
};

function governorEvidenceAdmissionKey(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "test") return "governor-test-evidence-admission-key";
  throw new Error("OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY is required for enabled evidence");
}

export class GovernorSqliteStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly actionIntents: GovernorActionIntentStore;
  readonly approvals: GovernorApprovalGrantStore;
  readonly deliveryCertifications: GovernorDeliveryCertificationStore;
  readonly checkpoints: GovernorCheckpointStore;
  readonly outbox: GovernorOutboxStore;
  readonly #receiptResolver: GovernorTrustedReceiptResolver;
  readonly #testReceiptCapabilities?: HostGovernorCapabilities;
  readonly #evidenceAdmissionKey: string;
  readonly #evidenceAdmissionKeyId: string;
  readonly #pendingEvidence = new WeakSet<object>();

  constructor(
    params: { stateDir?: string; receiptResolver?: GovernorTrustedReceiptResolver } = {},
  ) {
    const testBroker =
      !params.receiptResolver && process.env.NODE_ENV === "test"
        ? createHostGovernorBroker({ receiptSigningKey: "synthetic-store-test-receipt-key" })
        : undefined;
    const receiptResolver = params.receiptResolver ?? testBroker?.resolver;
    if (!receiptResolver || !isTrustedGovernorReceiptResolver(receiptResolver)) {
      throw new Error("Governor store requires a trusted host receipt resolver");
    }
    assertGovernorIdentityHmacKeyAvailable();
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
    this.#receiptResolver = receiptResolver;
    this.#testReceiptCapabilities = testBroker?.capabilities;
    this.#evidenceAdmissionKey = governorEvidenceAdmissionKey(process.env);
    this.#evidenceAdmissionKeyId =
      process.env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID?.trim() || "v1";
    this.actionIntents = new GovernorActionIntentStore(params);
    this.approvals = new GovernorApprovalGrantStore(params);
    this.deliveryCertifications = new GovernorDeliveryCertificationStore(params);
    this.checkpoints = new GovernorCheckpointStore(params);
    this.outbox = new GovernorOutboxStore(params);
  }

  #database() {
    return openOpenClawStateDatabase(this.#options);
  }

  #signEvidence(evidence: Omit<GovernorEvidenceRecord, "admissionSignature">): string {
    return crypto
      .createHmac("sha256", this.#evidenceAdmissionKey)
      .update(canonicalGovernorJson(governorEvidenceAdmissionPayload(evidence)))
      .digest("hex");
  }

  #assertVerifiedEvidence(evidence: GovernorEvidenceRecord): void {
    assertOpaqueEvidenceSourceRef(evidence.sourceIdentity);
    if (governorDigest(evidence.payload) !== evidence.evidenceDigest) {
      throw new Error("Governor evidence payload digest mismatch");
    }
    if (
      governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
      evidence.semanticDigest
    ) {
      throw new Error("Governor evidence semantic digest mismatch");
    }
    if (
      evidence.admissionVersion !== 1 ||
      evidence.admissionKeyId !== this.#evidenceAdmissionKeyId
    ) {
      throw new Error("Governor evidence admission key/version is not accepted");
    }
    const { admissionSignature, ...unsigned } = evidence;
    const expected = this.#signEvidence(unsigned);
    if (
      admissionSignature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(admissionSignature), Buffer.from(expected))
    ) {
      throw new Error("Governor evidence admission signature is invalid");
    }
  }

  /**
   * Resolves a host-observed receipt and creates a store-bound admission.
   * The caller never receives a signer or a persistable record capability.
   */
  admitEvidenceCandidate(params: {
    task: GovernorTaskProjection;
    candidate: GovernorEvidenceCandidate;
    receiptId?: string;
    now: number;
  }): GovernorPendingEvidence {
    const candidate = createGovernorEvidenceCandidate(params.candidate);
    const validation = validateGovernorEvidenceCandidate({ task: params.task, candidate });
    if (!validation.valid) {
      throw new Error(`Governor evidence candidate rejected: ${validation.reason}`);
    }
    const receiptId =
      params.receiptId ??
      this.#testReceiptCapabilities?.submitObservedReceipt({
        scopeKey: params.task.scopeKey,
        taskId: params.task.taskId,
        taskVersion: params.task.taskVersion,
        objectiveRevision: params.task.objectiveRevision,
        planVersion: params.task.planVersion,
        sourceKind: candidate.sourceKind as "tool" | "structured_external" | "authenticated_user",
        sourceIdentity: candidate.sourceIdentity,
        payload: candidate.payload,
        observedAt: candidate.observedAt,
      });
    if (!receiptId) {
      throw new Error("Governor evidence requires a trusted host receipt");
    }
    const receipt = this.#receiptResolver.resolve(
      receiptId as HostGovernorReceiptId,
      params.task.scopeKey,
    );
    if (!receipt) {
      throw new Error("Governor evidence receipt is unknown, invalid, or out of scope");
    }
    if (
      receipt.sourceKind !== candidate.sourceKind ||
      receipt.sourceIdentity !== candidate.sourceIdentity ||
      receipt.taskId !== candidate.taskId ||
      receipt.taskVersion !== candidate.taskVersion ||
      receipt.objectiveRevision !== candidate.objectiveRevision ||
      receipt.planVersion !== candidate.planVersion ||
      receipt.observedAt !== candidate.observedAt ||
      governorDigest(receipt.payload) !== candidate.evidenceDigest ||
      governorDigest(receipt.payload) !== governorDigest(candidate.payload)
    ) {
      throw new Error("Governor evidence candidate does not match its trusted receipt");
    }
    const semantic = deriveGovernorEvidenceSemantics({
      criterionId: candidate.criterionId,
      predicate: candidate.predicate,
      value: candidate.value,
      payload: receipt.payload,
    });
    const unsigned: Omit<GovernorEvidenceRecord, "admissionSignature"> = {
      ...candidate,
      payload: receipt.payload,
      evidenceDigest: governorDigest(receipt.payload),
      sourceIdentity: opaqueEvidenceSourceRef(receipt.sourceKind, receipt.sourceIdentity),
      ...semantic,
      admissibility: "admitted",
      createdAt: params.now,
      admissionKeyId: this.#evidenceAdmissionKeyId,
      admissionVersion: 1,
    };
    const evidence = Object.freeze({
      ...unsigned,
      admissionSignature: this.#signEvidence(unsigned),
    });
    const pending = Object.freeze({ evidence }) as GovernorPendingEvidence;
    this.#pendingEvidence.add(pending);
    return pending;
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
      const sourceMessageId = opaqueGovernorReference(
        `source-message:${incoming.scopeKey}`,
        params.sourceMessageId,
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
      if (params.evidenceAdmission) {
        if (!this.#pendingEvidence.has(params.evidenceAdmission)) {
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
        this.#assertVerifiedEvidence(evidence);
        executeSqliteQuerySync(
          db,
          dbx
            .insertInto("governor_evidence")
            .values(bindEvidence(evidence, (item) => this.#assertVerifiedEvidence(item)))
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
    ).rows.map((row) => parseEvidenceRow(row, (item) => this.#assertVerifiedEvidence(item)));
  }

  listUnfinishedFanoutJobIds(task: GovernorTaskProjection): string[] {
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_fanout_jobs")
        .select(["job_id"])
        .where("task_id", "=", task.taskId)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .where("state", "in", ["queued", "running"])
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows.map((row) => row.job_id);
  }
}
