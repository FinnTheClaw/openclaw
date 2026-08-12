// Schedules one evidence-qualified canonical-source repair through governed actions.
import {
  GovernorActionRuntime,
  type GovernorActionAdmissionResult,
  type GovernorExecutionFence,
} from "./action-runtime.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { GovernorActionRejectedError } from "./capability-registry.js";
import type { GovernorMemoryContradictionResolution } from "./memory-contradiction-store.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";
import { GovernorSqliteStore } from "./store.js";
import {
  isGovernorEffectSemanticallySuccessful,
  type GovernorActionProposal,
} from "./tool-outcome.js";
import type { GovernorTaskId } from "./types.js";

export type GovernorMemoryRepairAction = Omit<
  GovernorActionProposal,
  "taskId" | "effectId" | "mutating"
>;

export type GovernorMemoryResolutionResult = Readonly<{
  resolution: GovernorMemoryContradictionResolution;
  repairAdmission?: GovernorActionAdmissionResult;
}>;

function withRemediation(
  resolution: GovernorMemoryContradictionResolution,
  remediation: GovernorMemoryRemediation | null,
): GovernorMemoryContradictionResolution {
  if (!remediation || (resolution.kind !== "retired" && resolution.kind !== "duplicate")) {
    return resolution;
  }
  return { ...resolution, remediation };
}

function repairMutationGuard(
  remediation: GovernorMemoryRemediation,
  taskId: GovernorTaskId,
  executionFence: GovernorExecutionFence,
) {
  return {
    taskId,
    executionFence,
    expectedStatus: remediation.status,
    expectedUpdatedAt: remediation.updatedAt,
  } as const;
}

export class GovernorMemoryRemediationRuntime {
  constructor(
    readonly store: GovernorSqliteStore,
    readonly actions: GovernorActionRuntime,
  ) {}

  resolve(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    staleMemoryId: string;
    contradictionClass: string;
    executionFence: GovernorExecutionFence;
    progressVector: GovernorJsonValue;
    repairAction?: GovernorMemoryRepairAction;
    operatorRequested?: boolean;
    freshnessExpiresAt?: number;
    now: number;
  }): GovernorMemoryResolutionResult {
    const resolution = this.store.memory.resolveContradiction({
      taskId: params.taskId,
      evidenceId: params.evidenceId,
      staleMemoryId: params.staleMemoryId,
      contradictionClass: params.contradictionClass,
      executionFence: params.executionFence,
      ...(params.freshnessExpiresAt === undefined
        ? {}
        : { freshnessExpiresAt: params.freshnessExpiresAt }),
      now: params.now,
    });
    if (resolution.kind !== "retired" && resolution.kind !== "duplicate") {
      return { resolution };
    }
    let remediation = resolution.remediation;
    if (
      remediation.status === "blocked" &&
      params.operatorRequested &&
      params.repairAction &&
      remediation.taskId === params.taskId &&
      remediation.repairEffectId &&
      !this.store.actionIntents.load(params.taskId, remediation.repairEffectId) &&
      !this.store.loadEffect(params.taskId, remediation.repairEffectId)
    ) {
      remediation =
        this.store.memory.requeueRepair({
          fingerprint: remediation.contradictionFingerprint,
          now: params.now,
          guard: repairMutationGuard(remediation, params.taskId, params.executionFence),
        }) ?? remediation;
    }
    const currentResolution = withRemediation(resolution, remediation);
    if (remediation.status !== "queued") {
      return { resolution: currentResolution };
    }
    if (!remediation.repairEffectId) {
      const blocked = this.store.memory.updateRepairState({
        fingerprint: remediation.contradictionFingerprint,
        status: "blocked",
        blockedReason: "repair_effect_missing",
        now: params.now,
        guard: repairMutationGuard(remediation, params.taskId, params.executionFence),
      });
      return { resolution: withRemediation(currentResolution, blocked) };
    }
    if (!params.repairAction || remediation.taskId !== params.taskId) {
      const blocked = this.store.memory.updateRepairState({
        fingerprint: remediation.contradictionFingerprint,
        status: "blocked",
        blockedReason: params.repairAction ? "repair_task_mismatch" : "repair_not_available",
        now: params.now,
        guard: repairMutationGuard(remediation, params.taskId, params.executionFence),
      });
      return { resolution: withRemediation(currentResolution, blocked) };
    }
    try {
      const repairAdmission = this.actions.admit({
        taskId: params.taskId,
        executionFence: params.executionFence,
        proposal: {
          ...params.repairAction,
          effectId: remediation.repairEffectId as GovernorActionProposal["effectId"],
          mutating: true,
        },
        progressVector: params.progressVector,
        now: params.now,
      });
      if (!repairAdmission.accepted) {
        const blocked = this.store.memory.updateRepairState({
          fingerprint: remediation.contradictionFingerprint,
          status: "blocked",
          blockedReason: "repair_stale_execution",
          now: params.now,
          guard: repairMutationGuard(remediation, params.taskId, params.executionFence),
        });
        return {
          resolution: withRemediation(currentResolution, blocked),
          repairAdmission,
        };
      }
      return { resolution: currentResolution, repairAdmission };
    } catch (error) {
      const blockedReason =
        error instanceof GovernorActionRejectedError
          ? `repair_${error.code}`
          : "repair_admission_failed";
      const blocked = this.store.memory.updateRepairState({
        fingerprint: remediation.contradictionFingerprint,
        status: "blocked",
        blockedReason,
        now: params.now,
        guard: repairMutationGuard(remediation, params.taskId, params.executionFence),
      });
      return { resolution: withRemediation(currentResolution, blocked) };
    }
  }

  reconcile(params: {
    fingerprint: string;
    taskId: GovernorTaskId;
    verificationEvidenceId?: string;
    now: number;
  }): GovernorMemoryRemediation | null {
    const remediation = this.store.memory.loadRemediation(params.fingerprint);
    if (!remediation || remediation.taskId !== params.taskId || !remediation.repairEffectId) {
      return remediation;
    }
    const effect = this.store.loadEffect(params.taskId, remediation.repairEffectId);
    if (!effect) {
      return remediation;
    }
    const task = this.store.loadTask(params.taskId);
    if (
      !task ||
      effect.objectiveRevision !== task.objectiveRevision ||
      effect.planVersion !== task.planVersion ||
      effect.executionGeneration !== task.executionGeneration
    ) {
      throw new Error("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
    }
    const executionFence: GovernorExecutionFence = {
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      executionGeneration: task.executionGeneration,
    };
    if (
      !isGovernorEffectSemanticallySuccessful(effect) ||
      effect.verificationState !== "verified"
    ) {
      return this.store.memory.updateRepairState({
        fingerprint: params.fingerprint,
        status: "blocked",
        blockedReason: `repair_${effect.outcome.semantic}`,
        now: params.now,
        guard: repairMutationGuard(remediation, params.taskId, executionFence),
      });
    }
    if (!params.verificationEvidenceId) {
      return this.store.memory.updateRepairState({
        fingerprint: params.fingerprint,
        status: "repairing",
        now: params.now,
        guard: repairMutationGuard(remediation, params.taskId, executionFence),
      });
    }
    return this.store.memory.verifyRepair({
      taskId: params.taskId,
      evidenceId: params.verificationEvidenceId,
      fingerprint: params.fingerprint,
      now: params.now,
      guard: repairMutationGuard(remediation, params.taskId, executionFence),
    });
  }
}
