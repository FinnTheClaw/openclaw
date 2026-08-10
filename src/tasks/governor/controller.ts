// Orchestrates the feature-flagged governed task loop over durable state.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { assertValidGovernorPlan } from "./contracts.js";
import { createGovernorEventRecord } from "./events.js";
import {
  admitGovernorEvidence,
  createGovernorEvidenceCandidate,
  type GovernorEvidenceRecord,
  type GovernorEvidenceSourceKind,
} from "./evidence.js";
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import {
  evaluateGovernorFinish,
  type GovernorCompletionCertificate,
  type GovernorRecoveryDirective,
} from "./finish-gate.js";
import { evaluateGovernorActionAdmission } from "./progress-monitor.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { applyGovernorTransition } from "./state-machine.js";
import {
  GovernorSqliteStore,
  type GovernorCommitResult,
  type GovernorIngressResult,
  type GovernorOutboxClaimResult,
} from "./store.js";
import {
  createGovernorEffectRecord,
  type GovernorActionProposal,
  type GovernorEffectRecord,
  type GovernorToolOutcome,
} from "./tool-outcome.js";
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

export type GovernorExecutionFence = {
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
};

export type GovernorToolRecordResult =
  | {
      accepted: true;
      task: GovernorTaskProjection;
      effect: GovernorEffectRecord;
      evidence?: GovernorEvidenceRecord;
    }
  | { accepted: false; reason: "stale_execution"; task: GovernorTaskProjection };

export type GovernorMutationResolution = "applied_verified" | "not_applied_verified" | "failed";

export type GovernorDeliveryProvider = {
  send: (params: { deliveryKey: string; payload: GovernorJsonValue }) => Promise<GovernorJsonValue>;
};

function assertApplied(result: GovernorCommitResult): GovernorTaskProjection {
  if (!result.applied) {
    throw new Error(`Governor commit failed: ${result.reason}`);
  }
  return result.task;
}

function nextTaskVersion(task: GovernorTaskProjection, now: number): GovernorTaskProjection {
  return { ...task, taskVersion: task.taskVersion + 1, updatedAt: now };
}

export class GovernorController {
  constructor(
    readonly store: GovernorSqliteStore,
    readonly capabilities: GovernorCapabilityRegistry,
  ) {}

  ingest(params: {
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    mode: GovernorMode;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressResult {
    return this.store.ingest(params);
  }

  #task(taskId: GovernorTaskId): GovernorTaskProjection {
    const task = this.store.loadTask(taskId);
    if (!task) {
      throw new Error(`Governor task not found: ${taskId}`);
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
      throw new Error(`Governor transition failed: ${transition.reason}`);
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
      throw new Error(`Cannot prepare plan while task is ${task.state}`);
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

  recordToolOutcome(params: {
    taskId: GovernorTaskId;
    executionFence: GovernorExecutionFence;
    proposal: Omit<GovernorActionProposal, "taskId">;
    progressVector: GovernorJsonValue;
    outcome: GovernorToolOutcome;
    evidenceSourceKind?: GovernorEvidenceSourceKind;
    now: number;
  }): GovernorToolRecordResult {
    const task = this.#task(params.taskId);
    if (
      params.executionFence.objectiveRevision !== task.objectiveRevision ||
      params.executionFence.planVersion !== task.planVersion ||
      params.executionFence.executionGeneration !== task.executionGeneration ||
      params.executionFence.taskVersion > task.taskVersion
    ) {
      const event = createGovernorEventRecord({
        task,
        eventType: "late_tool_result_ignored",
        payload: {
          effectId: params.proposal.effectId,
          executionGeneration: params.executionFence.executionGeneration,
        },
        now: params.now,
      });
      this.store.appendAuditEvent({ task, event });
      return { accepted: false, reason: "stale_execution", task };
    }
    const existingEffect = this.store.loadEffect(task.taskId, params.proposal.effectId);
    if (existingEffect) {
      const existingEvidence = this.store
        .listEvidence(task.taskId)
        .find((item) => item.evidenceId === `evidence_${params.proposal.effectId}`);
      return {
        accepted: true,
        task,
        effect: existingEffect,
        ...(existingEvidence ? { evidence: existingEvidence } : {}),
      };
    }
    if (task.state !== "EXECUTING") {
      throw new Error(`Cannot record tool outcome while task is ${task.state}`);
    }
    const proposal = { ...params.proposal, taskId: task.taskId };
    this.capabilities.assertAuthorized(task, proposal);
    const admission = evaluateGovernorActionAdmission({
      proposal,
      progressVector: params.progressVector,
      priorEffects: this.store.listEffects(task.taskId),
      objectiveRevision: task.objectiveRevision,
    });
    if (!admission.admitted) {
      throw new Error(`Governor action rejected: ${admission.reason}`);
    }
    const effect = createGovernorEffectRecord({
      proposal,
      taskVersion: params.executionFence.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      progressVector: params.progressVector,
      outcome: params.outcome,
      now: params.now,
    });
    let evidence: GovernorEvidenceRecord | undefined;
    if (
      params.proposal.criterionId &&
      params.outcome.transport === "completed" &&
      params.outcome.semantic === "success" &&
      (!params.proposal.mutating || params.outcome.verification === "verified") &&
      params.outcome.evidence !== undefined
    ) {
      const candidate = createGovernorEvidenceCandidate({
        evidenceId: `evidence_${params.proposal.effectId}`,
        taskId: task.taskId,
        criterionId: params.proposal.criterionId,
        sourceKind: params.evidenceSourceKind ?? "tool",
        sourceIdentity: params.proposal.capability,
        taskVersion: params.executionFence.taskVersion,
        objectiveRevision: task.objectiveRevision,
        scopeKey: task.scopeKey,
        observedAt: params.now,
        payload: params.outcome.evidence,
      });
      const admission = admitGovernorEvidence({ task, candidate, now: params.now });
      if (admission.admitted) {
        evidence = admission.evidence;
      }
    }
    const next = admission.forceReplanAfterOutcome
      ? {
          ...task,
          state: "REPLAN_REQUIRED" as const,
          taskVersion: task.taskVersion + 1,
          updatedAt: params.now,
        }
      : nextTaskVersion(task, params.now);
    const event = createGovernorEventRecord({
      task: next,
      eventType: "tool_outcome_recorded",
      payload: {
        effectId: effect.effectId,
        semantic: effect.outcome.semantic,
        reconcileRequired: effect.reconcileRequired,
        forcedReplan: admission.forceReplanAfterOutcome,
      },
      now: params.now,
    });
    const committed = assertApplied(
      this.store.commit({
        current: task,
        next,
        event,
        effects: [effect],
        ...(evidence ? { evidence: [evidence] } : {}),
      }),
    );
    return { accepted: true, task: committed, effect, ...(evidence ? { evidence } : {}) };
  }

  beginVerification(taskId: GovernorTaskId, now: number): GovernorTaskProjection {
    return this.#transition(this.#task(taskId), "VERIFYING", now);
  }

  resolveMutation(params: {
    taskId: GovernorTaskId;
    executionFence: Omit<GovernorExecutionFence, "taskVersion">;
    effectId: string;
    resolution: GovernorMutationResolution;
    evidence: GovernorJsonValue;
    sourceIdentity: string;
    now: number;
  }): GovernorToolRecordResult {
    const task = this.#task(params.taskId);
    const safeEvidence = assertGovernorBoundarySafe("model", params.evidence);
    const effect = this.store.loadEffect(task.taskId, params.effectId);
    if (!effect || !effect.mutating) {
      throw new Error(`Governor mutation effect not found: ${params.effectId}`);
    }
    if (
      params.executionFence.objectiveRevision !== task.objectiveRevision ||
      params.executionFence.planVersion !== task.planVersion ||
      params.executionFence.executionGeneration !== task.executionGeneration ||
      effect.objectiveRevision !== task.objectiveRevision ||
      effect.executionGeneration !== task.executionGeneration
    ) {
      return { accepted: false, reason: "stale_execution", task };
    }
    const outcome: GovernorToolOutcome =
      params.resolution === "applied_verified"
        ? {
            transport: "completed",
            semantic: "success",
            sideEffect: "applied",
            verification: "verified",
            summaryCode: "mutation_applied_verified",
            evidence: safeEvidence,
          }
        : params.resolution === "not_applied_verified"
          ? {
              transport: "completed",
              semantic: "transient_failure",
              sideEffect: "none",
              verification: "verified",
              summaryCode: "mutation_not_applied_verified",
              evidence: safeEvidence,
            }
          : {
              transport: "completed",
              semantic: "partial",
              sideEffect: "unknown",
              verification: "failed",
              summaryCode: "mutation_reconciliation_failed",
              evidence: safeEvidence,
            };
    const updatedEffect: GovernorEffectRecord = {
      ...effect,
      outcome,
      verificationState: outcome.verification,
      reconcileRequired: params.resolution === "failed",
      updatedAt: params.now,
    };
    let evidence: GovernorEvidenceRecord | undefined;
    if (params.resolution === "applied_verified" && effect.criterionId) {
      const candidate = createGovernorEvidenceCandidate({
        evidenceId: `verification_${effect.effectId}`,
        taskId: task.taskId,
        criterionId: effect.criterionId,
        sourceKind: "structured_external",
        sourceIdentity: params.sourceIdentity,
        taskVersion: task.taskVersion,
        objectiveRevision: task.objectiveRevision,
        scopeKey: task.scopeKey,
        observedAt: params.now,
        payload: safeEvidence,
      });
      const admission = admitGovernorEvidence({ task, candidate, now: params.now });
      if (!admission.admitted) {
        throw new Error(`Governor mutation verification evidence rejected: ${admission.reason}`);
      }
      evidence = admission.evidence;
    }
    const next = nextTaskVersion(task, params.now);
    const event = createGovernorEventRecord({
      task: next,
      eventType: "mutation_reconciled",
      payload: {
        effectId: effect.effectId,
        resolution: params.resolution,
        evidenceDigest: governorDigest(safeEvidence),
      },
      now: params.now,
    });
    const committed = assertApplied(
      this.store.commit({
        current: task,
        next,
        event,
        effectUpdates: [{ current: effect, next: updatedEffect }],
        ...(evidence ? { evidence: [evidence] } : {}),
      }),
    );
    return {
      accepted: true,
      task: committed,
      effect: updatedEffect,
      ...(evidence ? { evidence } : {}),
    };
  }

  proposeFinish(params: {
    taskId: GovernorTaskId;
    responseText: string;
    contradictions?: readonly string[];
    pendingUserUpdate?: boolean;
    now: number;
  }): GovernorFinishResult {
    const safeFinish = assertGovernorBoundarySafe("session", {
      responseText: params.responseText,
      contradictions: [...(params.contradictions ?? [])],
    }) as { responseText: string; contradictions: string[] };
    let task = this.#task(params.taskId);
    if (task.state !== "VERIFYING") {
      throw new Error(`Cannot propose finish while task is ${task.state}`);
    }
    task = this.#transition(task, "FINISH_CANDIDATE", params.now);
    const decision = evaluateGovernorFinish({
      task,
      effects: this.store.listEffects(task.taskId),
      evidence: this.store.listEvidence(task.taskId),
      contradictions: safeFinish.contradictions,
      runningActionIds: this.store.listUnfinishedFanoutJobIds(task.taskId),
      pendingUserUpdate: params.pendingUserUpdate,
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
        throw new Error(`Governor recovery transition failed: ${transition.reason}`);
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
        },
        now: params.now + 1,
      });
      const recovered = assertApplied(
        this.store.commit({ current: task, next: transition.task, event }),
      );
      return { completed: false, task: recovered, recovery: decision.recovery };
    }
    const transition = applyGovernorTransition({
      task,
      expectedTaskVersion: task.taskVersion,
      expectedLeaseEpoch: task.leaseEpoch,
      to: "COMPLETED",
      now: params.now + 1,
    });
    if (!transition.applied) {
      throw new Error(`Governor completion transition failed: ${transition.reason}`);
    }
    const effectId = `completion_${transition.task.objectiveRevision}`;
    const payload: GovernorJsonValue = {
      kind: "completion",
      text: safeFinish.responseText,
      certificateDigest: decision.certificate.certificateDigest,
    };
    const outbox = this.store.createCompletionOutbox({
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
        outboxDeliveryKey: outbox.deliveryKey,
      },
      now: params.now + 1,
    });
    const completed = assertApplied(
      this.store.commit({ current: task, next: transition.task, event, outbox: [outbox] }),
    );
    return { completed: true, task: completed, certificate: decision.certificate };
  }

  async dispatchOutbox(params: {
    taskId: GovernorTaskId;
    effectId: string;
    expectedLeaseEpoch: number;
    workerId: string;
    leaseDurationMs?: number;
    provider: GovernorDeliveryProvider;
    now: number;
  }): Promise<GovernorOutboxClaimResult> {
    const claim = this.store.claimOutbox(params);
    if (claim.kind !== "claimed") {
      return claim;
    }
    const receipt = await params.provider.send({
      deliveryKey: claim.entry.deliveryKey,
      payload: claim.entry.payload,
    });
    return this.store.markOutboxSent({
      taskId: params.taskId,
      effectId: params.effectId,
      expectedLeaseEpoch: params.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
      workerId: params.workerId,
      providerReceipt: receipt,
      now: params.now + 1,
    });
  }
}

export function createGovernorControllerIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
}): GovernorController | null {
  if (!isBehaviorGovernorEnabled(params.env)) {
    return null;
  }
  return new GovernorController(
    new GovernorSqliteStore({ stateDir: params.stateDir }),
    new GovernorCapabilityRegistry(params.capabilities),
  );
}

export function governorArgumentsDigest(value: GovernorJsonValue): string {
  return governorDigest(value);
}
