import type { GovernorActionIntent } from "./action-intent.js";
import {
  GovernorActionRuntime,
  type GovernorActionAdmissionResult,
  type GovernorAdmitActionParams,
  type GovernorAcknowledgeActionTerminationParams,
  type GovernorBeginActionEffectParams,
  type GovernorClaimActionIntentParams,
  type GovernorExecutionFence,
  type GovernorRecordAdmittedToolOutcomeParams,
  type GovernorRecordToolOutcomeParams,
  type GovernorToolRecordResult,
} from "./action-runtime.js";
// Orchestrates the feature-flagged governed task loop over durable state.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { assertValidGovernorPlan } from "./contracts.js";
import {
  recordGovernorContradiction,
  resolveGovernorContradiction,
  setGovernorPendingUserUpdate,
  type GovernorContradictionRequest,
  type GovernorPendingUpdateRequest,
} from "./controller-conditions.js";
import {
  assessGovernorRuntimeFinish,
  blockGovernorRuntimeTask,
  recordGovernorRuntimeEvent,
  recordGovernorRuntimeReplanGuidance,
  requestGovernorRuntimeReplan,
  type GovernorRuntimeEventRequest,
  type GovernorRuntimeFinishRequest,
  type GovernorRuntimeBlockReason,
} from "./controller-runtime.js";
import { dispatchGovernorOutbox, type GovernorDispatchOutboxParams } from "./delivery-dispatch.js";
import { createGovernorEventRecord } from "./events.js";
import {
  evaluateGovernorFinish,
  type GovernorCompletionCertificate,
  type GovernorFinishDecision,
  type GovernorRecoveryDirective,
} from "./finish-gate.js";
import { admitGovernorMaterialClaims } from "./material-claim-admission.js";
import {
  assertGovernorResponseDraft,
  renderGovernorResponse,
  type GovernorMaterialClaimInput,
  type GovernorResponseDraft,
} from "./material-claims.js";
import { GovernorMemoryRemediationRuntime } from "./memory-remediation-runtime.js";
import {
  resolveGovernorMutation,
  type GovernorMutationResolution,
} from "./mutation-reconciliation.js";
import {
  createGovernorCheckpoint,
  type GovernorCheckpoint,
  type GovernorWorkProfile,
  type GovernorVerifiedCheckpointFact,
} from "./planning-policy.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { applyGovernorTransition, reclaimGovernorLease } from "./state-machine.js";
import {
  GovernorSqliteStore,
  type GovernorCommitResult,
  type GovernorIngressResult,
} from "./store.js";
import type {
  GovernorMode,
  GovernorPlan,
  GovernorTaskContract,
  GovernorTaskId,
  GovernorTaskProjection,
  GovernorTaskScope,
  GovernorTaskState,
} from "./types.js";

export type GovernorFinishResult =
  | { completed: true; task: GovernorTaskProjection; certificate: GovernorCompletionCertificate }
  | { completed: false; task: GovernorTaskProjection; recovery: GovernorRecoveryDirective };

export type {
  GovernorActionAdmissionResult,
  GovernorExecutionFence,
  GovernorToolRecordResult,
} from "./action-runtime.js";

export type { GovernorMutationResolution } from "./mutation-reconciliation.js";

function assertApplied(result: GovernorCommitResult): GovernorTaskProjection {
  if (!result.applied) {
    throw new Error("GOVERNOR_COMMIT_REJECTED");
  }
  return result.task;
}

function nextTaskVersion(task: GovernorTaskProjection, now: number): GovernorTaskProjection {
  return { ...task, taskVersion: task.taskVersion + 1, updatedAt: now };
}

export class GovernorController {
  readonly actions: GovernorActionRuntime;
  readonly memoryRemediation: GovernorMemoryRemediationRuntime;

  constructor(
    readonly store: GovernorSqliteStore,
    readonly capabilities: GovernorCapabilityRegistry,
  ) {
    if (store.capabilities !== capabilities) {
      throw new Error("Governor controller and store must share one capability registry");
    }
    this.actions = new GovernorActionRuntime(store, capabilities);
    this.memoryRemediation = new GovernorMemoryRemediationRuntime(store, this.actions);
  }

  ingest(params: {
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    mode?: GovernorMode;
    profile?: GovernorWorkProfile;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressResult {
    return this.store.ingest(params);
  }

  ingestHostSequenced(
    params: Omit<Parameters<GovernorController["ingest"]>[0], "sourceSequence">,
  ): GovernorIngressResult {
    return this.store.ingestHostSequenced(params);
  }

  #task(taskId: GovernorTaskId): GovernorTaskProjection {
    const task = this.store.loadTask(taskId);
    if (!task) {
      throw new Error("GOVERNOR_TASK_NOT_FOUND");
    }
    return task;
  }

  #transition(
    task: GovernorTaskProjection,
    to: GovernorTaskState,
    now: number,
  ): GovernorTaskProjection {
    const transition = applyGovernorTransition({
      task,
      expectedTaskVersion: task.taskVersion,
      expectedLeaseEpoch: task.leaseEpoch,
      to,
      now,
    });
    if (!transition.applied) {
      throw new Error("GOVERNOR_TRANSITION_REJECTED");
    }
    const event = createGovernorEventRecord({
      task: transition.task,
      eventType: "state_transitioned",
      payload: { from: task.state, to },
      now,
    });
    return assertApplied(this.store.commit({ current: task, next: transition.task, event }));
  }

  preparePlan(params: {
    taskId: GovernorTaskId;
    plan: GovernorPlan;
    now: number;
  }): GovernorTaskProjection {
    let task = this.#task(params.taskId);
    const plan = assertGovernorBoundarySafe(
      "session",
      params.plan as unknown as GovernorJsonValue,
    ) as unknown as GovernorPlan;
    assertValidGovernorPlan(plan, task.contract);
    if (task.state === "RECEIVED") {
      task = this.#transition(task, "CONTRACTING", params.now);
    }
    if (task.state === "CONTRACTING" || task.state === "REPLAN_REQUIRED") {
      task = this.#transition(task, "PLANNING", params.now + 1);
    }
    if (task.state !== "PLANNING") {
      throw new Error("GOVERNOR_PLAN_STATE_INVALID");
    }
    const planned: GovernorTaskProjection = {
      ...task,
      plan,
      planVersion: task.planVersion + 1,
      taskVersion: task.taskVersion + 1,
      updatedAt: params.now + 2,
    };
    const event = createGovernorEventRecord({
      task: planned,
      eventType: "plan_replaced",
      payload: { kind: plan.kind, stepCount: plan.steps.length },
      now: params.now + 2,
    });
    task = assertApplied(this.store.commit({ current: task, next: planned, event }));
    return this.#transition(task, "READY", params.now + 3);
  }

  startExecution(taskId: GovernorTaskId, now: number): GovernorTaskProjection {
    return this.#transition(this.#task(taskId), "EXECUTING", now);
  }

  captureExecutionFence(taskId: GovernorTaskId): GovernorExecutionFence {
    const task = this.#task(taskId);
    return {
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      executionGeneration: task.executionGeneration,
    };
  }

  reclaimTaskLease(params: {
    taskId: GovernorTaskId;
    expectedTaskVersion: number;
    expectedLeaseEpoch: number;
    now: number;
  }): GovernorTaskProjection {
    const task = this.#task(params.taskId);
    const reclaimed = reclaimGovernorLease({
      task,
      expectedTaskVersion: params.expectedTaskVersion,
      expectedLeaseEpoch: params.expectedLeaseEpoch,
      now: params.now,
    });
    if (!reclaimed.applied) {
      throw new Error("GOVERNOR_LEASE_RECLAIM_REJECTED");
    }
    const event = createGovernorEventRecord({
      task: reclaimed.task,
      eventType: "lease_reclaimed",
      payload: {
        previousLeaseEpoch: task.leaseEpoch,
        executionGeneration: reclaimed.task.executionGeneration,
      },
      now: params.now,
    });
    return assertApplied(this.store.commit({ current: task, next: reclaimed.task, event }));
  }

  recordCheckpoint(params: {
    taskId: GovernorTaskId;
    checkpointId: string;
    verifiedFacts: readonly GovernorVerifiedCheckpointFact[];
    discardedAssumptions: readonly string[];
    unresolvedQuestions: readonly string[];
    nextDiscriminatingAction: string;
    competingHypotheses?: readonly string[];
    now: number;
  }): { task: GovernorTaskProjection; checkpoint: GovernorCheckpoint } {
    const task = this.#task(params.taskId);
    const next = nextTaskVersion(task, params.now);
    const checkpoint = createGovernorCheckpoint({
      checkpointId: params.checkpointId,
      task: next,
      verifiedFacts: params.verifiedFacts,
      discardedAssumptions: params.discardedAssumptions,
      unresolvedQuestions: params.unresolvedQuestions,
      nextDiscriminatingAction: params.nextDiscriminatingAction,
      ...(params.competingHypotheses ? { competingHypotheses: params.competingHypotheses } : {}),
      now: params.now,
    });
    const event = createGovernorEventRecord({
      task: next,
      eventType: "checkpoint_recorded",
      payload: {
        checkpointId: checkpoint.checkpointId,
        verifiedFactCount: checkpoint.verifiedFacts.length,
        unresolvedQuestionCount: checkpoint.unresolvedQuestions.length,
      },
      now: params.now,
    });
    return {
      task: assertApplied(
        this.store.commit({ current: task, next, event, checkpoints: [checkpoint] }),
      ),
      checkpoint,
    };
  }

  admitAction(params: GovernorAdmitActionParams): GovernorActionAdmissionResult {
    return this.actions.admit(params);
  }

  isActionIntentExecutable(intent: GovernorActionIntent): boolean {
    return this.actions.isExecutable(intent);
  }

  claimActionIntent(params: GovernorClaimActionIntentParams) {
    return this.actions.claim(params);
  }

  beginActionEffect(params: GovernorBeginActionEffectParams) {
    return this.actions.beginEffect(params);
  }

  acknowledgeActionTermination(params: GovernorAcknowledgeActionTerminationParams) {
    return this.actions.acknowledgeTermination(params);
  }

  recordAdmittedToolOutcome(
    params: GovernorRecordAdmittedToolOutcomeParams,
  ): GovernorToolRecordResult {
    return this.actions.record(params);
  }

  recordToolOutcome(params: GovernorRecordToolOutcomeParams): GovernorToolRecordResult {
    return this.actions.recordInline(params);
  }

  beginVerification(taskId: GovernorTaskId, now: number): GovernorTaskProjection {
    return this.#transition(this.#task(taskId), "VERIFYING", now);
  }

  recordRuntimeEvent(params: GovernorRuntimeEventRequest): GovernorTaskProjection {
    return recordGovernorRuntimeEvent(this.store, this.#task(params.taskId), params);
  }

  requestRuntimeReplan(taskId: GovernorTaskId, now: number): GovernorTaskProjection {
    return requestGovernorRuntimeReplan(this.store, this.#task(taskId), now);
  }

  recordRuntimeReplanGuidance(
    taskId: GovernorTaskId,
    now: number,
    request: Parameters<typeof recordGovernorRuntimeReplanGuidance>[3],
  ): GovernorTaskProjection {
    return recordGovernorRuntimeReplanGuidance(this.store, this.#task(taskId), now, request);
  }

  blockRuntime(taskId: GovernorTaskId, now: number, reasonCode: GovernorRuntimeBlockReason) {
    return blockGovernorRuntimeTask(this.store, this.#task(taskId), now, reasonCode);
  }

  assessFinish(params: GovernorRuntimeFinishRequest): GovernorFinishDecision {
    return assessGovernorRuntimeFinish(this.store, this.#task(params.taskId), params);
  }

  setPendingUserUpdate(params: GovernorPendingUpdateRequest): GovernorTaskProjection {
    return setGovernorPendingUserUpdate(this.store, this.#task(params.taskId), params);
  }

  recordContradiction(params: GovernorContradictionRequest): GovernorTaskProjection {
    return recordGovernorContradiction(this.store, this.#task(params.taskId), params);
  }

  resolveContradiction(
    taskId: GovernorTaskId,
    contradictionId: string,
    now: number,
  ): GovernorTaskProjection {
    return resolveGovernorContradiction(this.store, this.#task(taskId), contradictionId, now);
  }

  resolveMutation(params: {
    taskId: GovernorTaskId;
    executionFence: Omit<GovernorExecutionFence, "taskVersion">;
    effectId: string;
    resolution: GovernorMutationResolution;
    evidence: GovernorJsonValue;
    sourceIdentity: string;
    evidenceReceiptId?: string;
    now: number;
  }): GovernorToolRecordResult {
    return resolveGovernorMutation({ store: this.store, ...params });
  }

  admitMaterialClaims(params: {
    taskId: GovernorTaskId;
    claims: readonly GovernorMaterialClaimInput[];
    now: number;
  }): GovernorTaskProjection {
    const task = this.#task(params.taskId);
    if (task.state !== "VERIFYING") {
      throw new Error("GOVERNOR_MATERIAL_CLAIM_STATE_INVALID");
    }
    const admission = admitGovernorMaterialClaims({
      store: this.store,
      task,
      claims: params.claims,
      now: params.now,
    });
    return assertApplied(this.store.commit({ current: task, ...admission }));
  }

  proposeFinish(params: {
    taskId: GovernorTaskId;
    response: GovernorResponseDraft;
    now: number;
  }): GovernorFinishResult {
    let task = this.#task(params.taskId);
    const responseDraft = assertGovernorResponseDraft(params.response);
    if (task.state !== "VERIFYING") {
      throw new Error("GOVERNOR_FINISH_STATE_INVALID");
    }
    task = this.#transition(task, "FINISH_CANDIDATE", params.now);
    const runningActionIds = [
      ...this.store.actionIntents.listPendingIds(task.taskId, task.objectiveRevision, params.now),
      ...this.store.listUnfinishedFanoutJobIds(task),
    ].toSorted();
    const decision = evaluateGovernorFinish({
      task,
      effects: this.store.listCurrentEffects(task.taskId),
      evidence: this.store.listEvidence(task.taskId),
      runningActionIds,
      response: responseDraft,
      now: params.now + 1,
    });
    if (!decision.accepted) {
      const transition = applyGovernorTransition({
        task,
        expectedTaskVersion: task.taskVersion,
        expectedLeaseEpoch: task.leaseEpoch,
        to: "REPLAN_REQUIRED",
        now: params.now + 1,
      });
      if (!transition.applied) {
        throw new Error("GOVERNOR_RECOVERY_TRANSITION_REJECTED");
      }
      const event = createGovernorEventRecord({
        task: transition.task,
        eventType: "finish_rejected",
        payload: {
          unmetCriteria: [...decision.recovery.unmetCriteria],
          semanticFailures: [...decision.recovery.semanticFailures],
          reconciliationEffectIds: [...decision.recovery.reconciliationEffectIds],
          runningActionIds: [...decision.recovery.runningActionIds],
          pendingUserUpdate: decision.recovery.pendingUserUpdate,
          unsupportedMaterialClaimIds: [...decision.recovery.unsupportedMaterialClaimIds],
        },
        now: params.now + 1,
      });
      const recovered = assertApplied(
        this.store.commit({ current: task, next: transition.task, event }),
      );
      return { completed: false, task: recovered, recovery: decision.recovery };
    }
    const response = renderGovernorResponse({ task, draft: responseDraft });
    const transition = applyGovernorTransition({
      task,
      expectedTaskVersion: task.taskVersion,
      expectedLeaseEpoch: task.leaseEpoch,
      to: "COMPLETED",
      now: params.now + 1,
    });
    if (!transition.applied) {
      throw new Error("GOVERNOR_COMPLETION_TRANSITION_REJECTED");
    }
    const effectId = `completion_${transition.task.objectiveRevision}`;
    const payload: GovernorJsonValue = {
      kind: "completion",
      text: response,
      certificateDigest: decision.certificate.certificateDigest,
    };
    const outbox = this.store.outbox.createCompletion({
      task: transition.task,
      effectId,
      payload,
      now: params.now + 1,
    });
    const event = createGovernorEventRecord({
      task: transition.task,
      eventType: "completion_certified",
      payload: {
        certificateDigest: decision.certificate.certificateDigest,
        objectiveRevision: decision.certificate.objectiveRevision,
        planVersion: decision.certificate.planVersion,
        executionGeneration: decision.certificate.executionGeneration,
        evidenceDigests: [...decision.certificate.evidenceDigests],
        verifiedAt: decision.certificate.verifiedAt,
        outboxDeliveryKey: outbox.deliveryKey,
      },
      now: params.now + 1,
    });
    const completed = assertApplied(
      this.store.commit({ current: task, next: transition.task, event, outbox: [outbox] }),
    );
    return { completed: true, task: completed, certificate: decision.certificate };
  }

  async dispatchOutbox(params: GovernorDispatchOutboxParams) {
    return dispatchGovernorOutbox({
      store: this.store,
      adapterHandle: params.adapterHandle,
      request: params,
    });
  }
}

export function governorArgumentsDigest(value: GovernorJsonValue): string {
  return governorDigest(value);
}
