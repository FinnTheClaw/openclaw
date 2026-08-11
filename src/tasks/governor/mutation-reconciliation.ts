// Reconciles uncertain mutations into a durable effect update and admissible verification evidence.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { createGovernorEventRecord } from "./events.js";
import { createGovernorEvidenceCandidate, type GovernorEvidenceRecord } from "./evidence.js";
import { assertGovernorJsonResources } from "./resource-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorEffectRecord, GovernorToolOutcome } from "./tool-outcome.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorMutationResolution = "applied_verified" | "not_applied_verified" | "failed";

export type GovernorMutationResolutionResult =
  | {
      accepted: true;
      task: GovernorTaskProjection;
      effect: GovernorEffectRecord;
      evidence?: GovernorEvidenceRecord;
    }
  | { accepted: false; reason: "stale_execution"; task: GovernorTaskProjection };

export function resolveGovernorMutation(params: {
  store: GovernorSqliteStore;
  taskId: GovernorTaskId;
  executionFence: {
    objectiveRevision: number;
    planVersion: number;
    executionGeneration: number;
  };
  effectId: string;
  resolution: GovernorMutationResolution;
  evidence: GovernorJsonValue;
  sourceIdentity: string;
  evidenceReceiptId?: string;
  now: number;
}): GovernorMutationResolutionResult {
  assertGovernorJsonResources({
    taskId: params.taskId,
    executionFence: params.executionFence,
    effectId: params.effectId,
    resolution: params.resolution,
    evidence: params.evidence,
    sourceIdentity: params.sourceIdentity,
    evidenceReceiptId: params.evidenceReceiptId ?? null,
    now: params.now,
  });
  const task = params.store.loadTask(params.taskId);
  if (!task) {
    throw new Error(`Governor task not found: ${params.taskId}`);
  }
  const safeEvidence = assertGovernorBoundarySafe("model", params.evidence);
  const effect = params.store.loadEffect(task.taskId, params.effectId);
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
  let evidenceAdmission: ReturnType<GovernorSqliteStore["admitEvidenceCandidate"]> | undefined;
  if (params.resolution === "applied_verified" && effect.criterionId) {
    const candidate = createGovernorEvidenceCandidate({
      evidenceId: `verification_${task.taskId}_${effect.effectId}`,
      taskId: task.taskId,
      criterionId: effect.criterionId,
      sourceKind: "structured_external",
      // The asserted source is checked against the host receipt before it can persist.
      sourceIdentity: params.sourceIdentity,
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      scopeKey: task.scopeKey,
      observedAt: params.now,
      payload: safeEvidence,
    });
    evidenceAdmission = params.store.admitEvidenceCandidate({
      task,
      candidate,
      receiptId: params.evidenceReceiptId,
      now: params.now,
    });
    evidence = evidenceAdmission.evidence;
  }
  const next: GovernorTaskProjection = {
    ...task,
    claims: evidence
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
      : task.claims,
    taskVersion: task.taskVersion + 1,
    updatedAt: params.now,
  };
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
  const committed = params.store.commit({
    current: task,
    next,
    event,
    effectUpdates: [{ current: effect, next: updatedEffect }],
    ...(evidenceAdmission ? { evidenceAdmission } : {}),
  });
  if (!committed.applied) {
    throw new Error(`Governor commit failed: ${committed.reason}`);
  }
  return {
    accepted: true,
    task: committed.task,
    effect: updatedEffect,
    ...(evidence ? { evidence } : {}),
  };
}
