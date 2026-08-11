import type { HostGovernorReceiptId } from "../../security/governor-host-readonly.js";
// Reserves, fences, executes, and records semantic tool actions for governed tasks.
import {
  createGovernorActionIntent,
  isSameGovernorActionIntent,
  toPersistentGovernorActionProposal,
  type GovernorActionIntent,
  type GovernorActionTerminationOutcome,
} from "./action-intent.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import {
  GovernorActionRejectedError,
  type GovernorCapabilityRegistry,
} from "./capability-registry.js";
import { createGovernorEventRecord } from "./events.js";
import {
  createGovernorEvidenceCandidate,
  type GovernorEvidenceRecord,
  type GovernorEvidenceSourceKind,
} from "./evidence.js";
import { evaluateGovernorActionAdmission } from "./progress-monitor.js";
import type { GovernorCommitResult, GovernorSqliteStore } from "./store.js";
import {
  createGovernorEffectRecord,
  type GovernorActionProposal,
  type GovernorEffectRecord,
  type GovernorToolOutcome,
} from "./tool-outcome.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

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

export type GovernorActionAdmissionResult =
  | { accepted: true; task: GovernorTaskProjection; intent: GovernorActionIntent }
  | { accepted: false; reason: "stale_execution"; task: GovernorTaskProjection };

export type GovernorAdmitActionParams = {
  taskId: GovernorTaskId;
  executionFence: GovernorExecutionFence;
  proposal: Omit<GovernorActionProposal, "taskId">;
  progressVector: GovernorJsonValue;
  now: number;
};

export type GovernorClaimActionIntentParams = {
  intent: GovernorActionIntent;
  workerId: string;
  leaseDurationMs?: number;
  now: number;
};

export type GovernorBeginActionEffectParams = {
  intent: GovernorActionIntent;
  workerId: string;
  claimEpoch: number;
  now: number;
};

export type GovernorAcknowledgeActionTerminationParams = {
  taskId: GovernorTaskId;
  effectId: string;
  receiptId: HostGovernorReceiptId;
  outcome: GovernorActionTerminationOutcome;
  now: number;
};

export type GovernorRecordAdmittedToolOutcomeParams = {
  taskId: GovernorTaskId;
  intent: GovernorActionIntent;
  workerId: string;
  claimEpoch: number;
  outcome: GovernorToolOutcome;
  evidenceSourceKind?: GovernorEvidenceSourceKind;
  /** Opaque receipt emitted by the host tool/channel integration. */
  evidenceReceiptId?: string;
  now: number;
};

export type GovernorRecordToolOutcomeParams = {
  taskId: GovernorTaskId;
  executionFence: GovernorExecutionFence;
  proposal: Omit<GovernorActionProposal, "taskId">;
  progressVector: GovernorJsonValue;
  outcome: GovernorToolOutcome;
  evidenceSourceKind?: GovernorEvidenceSourceKind;
  /** Opaque receipt emitted by the host tool/channel integration. */
  evidenceReceiptId?: string;
  now: number;
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

function rejectLateResult(params: {
  store: GovernorSqliteStore;
  task: GovernorTaskProjection;
  effectId: string;
  executionGeneration: number;
  now: number;
}): GovernorToolRecordResult {
  const event = createGovernorEventRecord({
    task: params.task,
    eventType: "late_tool_result_ignored",
    payload: {
      effectId: params.effectId,
      executionGeneration: params.executionGeneration,
    },
    now: params.now,
  });
  params.store.appendAuditEvent({ task: params.task, event });
  return { accepted: false, reason: "stale_execution", task: params.task };
}

export class GovernorActionRuntime {
  constructor(
    readonly store: GovernorSqliteStore,
    readonly capabilities: GovernorCapabilityRegistry,
  ) {}

  #task(taskId: GovernorTaskId): GovernorTaskProjection {
    const task = this.store.loadTask(taskId);
    if (!task) {
      throw new Error(`Governor task not found: ${taskId}`);
    }
    return task;
  }

  admit(params: GovernorAdmitActionParams): GovernorActionAdmissionResult {
    const task = this.#task(params.taskId);
    const proposal = { ...params.proposal, taskId: task.taskId };
    const persistedProposal = toPersistentGovernorActionProposal(proposal, this.store.identity);
    const existing = this.store.actionIntents.load(task.taskId, proposal.effectId);
    if (existing) {
      const stale =
        existing.objectiveRevision !== task.objectiveRevision ||
        existing.planVersion !== task.planVersion ||
        existing.leaseEpoch !== task.leaseEpoch ||
        existing.executionGeneration !== task.executionGeneration;
      if (stale) {
        return { accepted: false, reason: "stale_execution", task };
      }
      if (!isSameGovernorActionIntent(existing, persistedProposal)) {
        throw new Error(`Conflicting governor action intent ${proposal.effectId}`);
      }
      return { accepted: true, task, intent: existing };
    }
    if (
      params.executionFence.objectiveRevision !== task.objectiveRevision ||
      params.executionFence.planVersion !== task.planVersion ||
      params.executionFence.executionGeneration !== task.executionGeneration ||
      params.executionFence.taskVersion > task.taskVersion
    ) {
      return { accepted: false, reason: "stale_execution", task };
    }
    if (task.state !== "EXECUTING") {
      throw new Error(`Cannot admit tool action while task is ${task.state}`);
    }
    this.capabilities.assertAuthorized(task, proposal);
    if (proposal.mutating && this.capabilities.requiresApproval(proposal.capability)) {
      const approval = this.store.approvalStatus(task, proposal, params.now);
      if (approval === "revoked") {
        throw new GovernorActionRejectedError("approval_revoked");
      }
      if (approval === "stale") {
        throw new GovernorActionRejectedError("approval_stale");
      }
      if (approval !== "approved") {
        throw new GovernorActionRejectedError("approval_required");
      }
    }
    const admission = evaluateGovernorActionAdmission({
      proposal,
      progressVector: params.progressVector,
      priorEffects: this.store.listEffects(task.taskId),
      objectiveRevision: task.objectiveRevision,
      identity: this.store.identity,
    });
    if (!admission.admitted) {
      throw new Error(`Governor action rejected: ${admission.reason}`);
    }
    const approvalPolicy = this.capabilities.approvalPolicy(proposal);
    const intent = createGovernorActionIntent({
      task,
      proposal,
      progressVector: params.progressVector,
      forceReplanAfterOutcome: admission.forceReplanAfterOutcome,
      approvalRequired: approvalPolicy.required,
      approvalPolicyDigest: approvalPolicy.digest,
      now: params.now,
      identity: this.store.identity,
    });
    const next = nextTaskVersion(task, params.now);
    const event = createGovernorEventRecord({
      task: next,
      eventType: "action_admitted",
      payload: {
        effectId: intent.effectId,
        idempotencyKey: intent.idempotencyKey,
        capability: intent.proposal.capability,
        mutating: intent.proposal.mutating,
      },
      now: params.now,
    });
    const committed = assertApplied(
      this.store.commit({ current: task, next, event, actionIntents: [intent] }),
    );
    return { accepted: true, task: committed, intent };
  }

  isExecutable(intent: GovernorActionIntent): boolean {
    const task = this.store.loadTask(intent.taskId);
    const stored = task ? this.store.actionIntents.load(task.taskId, intent.effectId) : null;
    if (
      !task ||
      !stored ||
      !isSameGovernorActionIntent(stored, intent.proposal) ||
      stored.state !== "admitted" ||
      stored.objectiveRevision !== task.objectiveRevision ||
      stored.planVersion !== task.planVersion ||
      stored.leaseEpoch !== task.leaseEpoch ||
      stored.executionGeneration !== task.executionGeneration ||
      task.state !== "EXECUTING"
    ) {
      return false;
    }
    try {
      this.capabilities.assertPersistedIntentAuthorized(task, stored.proposal, this.store.identity);
      const approvalPolicy = this.capabilities.approvalPolicy(stored.proposal);
      if (
        stored.approvalRequired !== approvalPolicy.required ||
        stored.approvalPolicyDigest !== approvalPolicy.digest
      ) {
        return false;
      }
      if (
        stored.approvalRequired &&
        this.store.approvalStatus(task, stored.proposal, Date.now()) !== "approved"
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  claim(params: GovernorClaimActionIntentParams) {
    return this.store.actionIntents.claim({
      taskId: params.intent.taskId,
      effectId: params.intent.effectId,
      objectiveRevision: params.intent.objectiveRevision,
      planVersion: params.intent.planVersion,
      leaseEpoch: params.intent.leaseEpoch,
      executionGeneration: params.intent.executionGeneration,
      workerId: params.workerId,
      leaseDurationMs: params.leaseDurationMs,
      now: params.now,
    });
  }

  beginEffect(params: GovernorBeginActionEffectParams) {
    return this.store.actionIntents.beginEffect({
      taskId: params.intent.taskId,
      effectId: params.intent.effectId,
      workerId: params.workerId,
      claimEpoch: params.claimEpoch,
      objectiveRevision: params.intent.objectiveRevision,
      planVersion: params.intent.planVersion,
      leaseEpoch: params.intent.leaseEpoch,
      executionGeneration: params.intent.executionGeneration,
      now: params.now,
    });
  }

  acknowledgeTermination(params: GovernorAcknowledgeActionTerminationParams) {
    return this.store.actionIntents.acknowledgeTermination(params);
  }

  record(params: GovernorRecordAdmittedToolOutcomeParams): GovernorToolRecordResult {
    const initialTask = this.#task(params.taskId);
    const loadedIntent = this.store.actionIntents.load(initialTask.taskId, params.intent.effectId);
    if (!loadedIntent || !isSameGovernorActionIntent(loadedIntent, params.intent.proposal)) {
      throw new Error(`Governor action intent not found: ${params.intent.effectId}`);
    }
    const existingEffect = this.store.loadEffect(initialTask.taskId, loadedIntent.effectId);
    if (existingEffect) {
      if (
        existingEffect.objectiveRevision !== initialTask.objectiveRevision ||
        existingEffect.planVersion !== initialTask.planVersion ||
        existingEffect.leaseEpoch !== initialTask.leaseEpoch ||
        existingEffect.executionGeneration !== initialTask.executionGeneration
      ) {
        return { accepted: false, reason: "stale_execution", task: initialTask };
      }
      const existingEvidence = this.store
        .listEvidence(initialTask.taskId)
        .find((item) => item.evidenceId === `evidence_${loadedIntent.effectId}`);
      return {
        accepted: true,
        task: initialTask,
        effect: existingEffect,
        ...(existingEvidence ? { evidence: existingEvidence } : {}),
      };
    }
    const validation = this.store.actionIntents.validateOutcome({
      taskId: params.taskId,
      effectId: params.intent.effectId,
      workerId: params.workerId,
      claimEpoch: params.claimEpoch,
      objectiveRevision: params.intent.objectiveRevision,
      planVersion: params.intent.planVersion,
      leaseEpoch: params.intent.leaseEpoch,
      executionGeneration: params.intent.executionGeneration,
      now: params.now,
    });
    if (validation.kind !== "ready") {
      return rejectLateResult({
        store: this.store,
        task: initialTask,
        effectId: loadedIntent.effectId,
        executionGeneration: loadedIntent.executionGeneration,
        now: params.now,
      });
    }
    const task = validation.task;
    const intent = validation.intent;
    if (task.state !== "EXECUTING") {
      throw new Error(`Cannot record tool outcome while task is ${task.state}`);
    }
    const effect = createGovernorEffectRecord({
      proposal: intent.proposal,
      taskVersion: intent.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      progressVector: { persistedProgressHash: intent.progressVectorHash },
      outcome: params.outcome,
      now: params.now,
      identity: this.store.identity,
    });
    effect.progressVectorHash = intent.progressVectorHash;
    let evidence: GovernorEvidenceRecord | undefined;
    let evidenceAdmission: ReturnType<GovernorSqliteStore["admitEvidenceCandidate"]> | undefined;
    if (
      intent.proposal.criterionId &&
      params.outcome.transport === "completed" &&
      params.outcome.semantic === "success" &&
      (!intent.proposal.mutating || params.outcome.verification === "verified") &&
      params.outcome.evidence !== undefined &&
      params.evidenceSourceKind !== "assistant_text" &&
      params.evidenceSourceKind !== "hidden_reasoning"
    ) {
      const candidate = createGovernorEvidenceCandidate({
        evidenceId: `evidence_${task.taskId}_${intent.effectId}`,
        taskId: task.taskId,
        criterionId: intent.proposal.criterionId,
        sourceKind: params.evidenceSourceKind ?? "tool",
        sourceIdentity: intent.proposal.capability,
        taskVersion: intent.taskVersion,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        scopeKey: task.scopeKey,
        observedAt: params.now,
        payload: params.outcome.evidence,
      });
      evidenceAdmission = this.store.admitEvidenceCandidate({
        task,
        candidate,
        receiptId: params.evidenceReceiptId,
        now: params.now,
      });
      evidence = evidenceAdmission.evidence;
    }
    const claims = evidence
      ? [
          ...task.claims,
          {
            claimId: evidence.criterionId,
            evidenceDigest: evidence.evidenceDigest,
            objectiveRevision: evidence.objectiveRevision,
            planVersion: evidence.planVersion,
            scopeKey: evidence.scopeKey,
            admittedAt: evidence.createdAt,
          },
        ]
      : task.claims;
    const next = intent.forceReplanAfterOutcome
      ? {
          ...task,
          state: "REPLAN_REQUIRED" as const,
          claims,
          taskVersion: task.taskVersion + 1,
          updatedAt: params.now,
        }
      : { ...nextTaskVersion(task, params.now), claims };
    const event = createGovernorEventRecord({
      task: next,
      eventType: "tool_outcome_recorded",
      payload: {
        effectId: effect.effectId,
        semantic: effect.outcome.semantic,
        reconcileRequired: effect.reconcileRequired,
        forcedReplan: intent.forceReplanAfterOutcome,
      },
      now: params.now,
    });
    const completedIntent: GovernorActionIntent = {
      ...intent,
      state: "completed",
      claimedBy: params.workerId,
      completedAt: params.now,
      updatedAt: params.now,
    };
    delete completedIntent.leaseExpiresAt;
    let committed: GovernorTaskProjection;
    try {
      committed = assertApplied(
        this.store.commit({
          current: task,
          next,
          event,
          effects: [effect],
          actionIntentUpdates: [{ current: intent, next: completedIntent }],
          ...(evidenceAdmission ? { evidenceAdmission } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("Concurrent governor action intent")) {
        return rejectLateResult({
          store: this.store,
          task: this.#task(params.taskId),
          effectId: intent.effectId,
          executionGeneration: intent.executionGeneration,
          now: params.now,
        });
      }
      throw error;
    }
    return { accepted: true, task: committed, effect, ...(evidence ? { evidence } : {}) };
  }

  recordInline(params: GovernorRecordToolOutcomeParams): GovernorToolRecordResult {
    const admission = this.admit(params);
    if (!admission.accepted) {
      return rejectLateResult({
        store: this.store,
        task: admission.task,
        effectId: params.proposal.effectId,
        executionGeneration: params.executionFence.executionGeneration,
        now: params.now,
      });
    }
    const workerId = `inline-${admission.intent.effectId}`;
    const claim = this.claim({ intent: admission.intent, workerId, now: params.now });
    if (claim.kind === "completed") {
      return this.record({
        taskId: params.taskId,
        intent: admission.intent,
        workerId,
        claimEpoch: admission.intent.claimEpoch,
        outcome: params.outcome,
        evidenceSourceKind: params.evidenceSourceKind,
        evidenceReceiptId: params.evidenceReceiptId,
        now: params.now,
      });
    }
    if (claim.kind !== "claimed") {
      throw new Error(`Governor action claim failed: ${claim.kind}`);
    }
    const started = this.beginEffect({
      intent: claim.intent,
      workerId,
      claimEpoch: claim.intent.claimEpoch,
      now: params.now,
    });
    if (started.kind !== "started") {
      throw new Error(`Governor action effect fence failed: ${started.kind}`);
    }
    return this.record({
      taskId: params.taskId,
      intent: started.intent,
      workerId,
      claimEpoch: started.intent.claimEpoch,
      outcome: params.outcome,
      evidenceSourceKind: params.evidenceSourceKind,
      evidenceReceiptId: params.evidenceReceiptId,
      now: params.now,
    });
  }
}
