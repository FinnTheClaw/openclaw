import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorEffectRecord } from "../tasks/governor/tool-outcome.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import { buildGovernorAgentLoopPlan } from "./governor-agent-loop-plan.js";

export type GovernorAgentLoopTransientFailureResult =
  | { kind: "replanned"; checkpointId: string; fromPlanVersion: number; planVersion: number }
  | { kind: "already_replanned"; checkpointId: string; planVersion: number }
  | { kind: "retry_exhausted" }
  | { kind: "not_eligible" };

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function failedCurrentEffect(
  controller: GovernorController,
  taskId: GovernorTaskId,
  effectId: string,
): GovernorEffectRecord | undefined {
  const effect = controller.store.loadEffect(taskId, effectId);
  return effect?.outcome.transport === "failed" && effect.outcome.semantic === "transient_failure"
    ? effect
    : undefined;
}

function checkpointId(effect: GovernorEffectRecord): string {
  return `gcheckpoint_${governorDigest({
    taskId: effect.taskId,
    objectiveRevision: effect.objectiveRevision,
    executionGeneration: effect.executionGeneration,
    actionFingerprint: effect.actionFingerprint,
    fromPlanVersion: effect.planVersion,
  }).slice(0, 48)}`;
}

function hasCurrentEvidence(
  controller: GovernorController,
  taskId: string,
  planVersion: number,
  criterionId: string | undefined,
) {
  if (!criterionId) {
    return false;
  }
  return controller.store
    .listEvidence(taskId as never)
    .some(
      (evidence) =>
        evidence.planVersion === planVersion &&
        evidence.criterionId === criterionId &&
        evidence.admissibility === "admitted" &&
        evidence.invalidatedAt === undefined,
    );
}

function priorCause(
  controller: GovernorController,
  taskId: string,
  actionFingerprint: string,
): Record<string, unknown> | undefined {
  return controller.store
    .listEvents(taskId as never)
    .toReversed()
    .map((event) => payloadRecord(event.payload))
    .find(
      (payload) =>
        payload?.guidanceOnly !== true &&
        payload?.reasonCode === "tool_semantic_failure" &&
        payload?.actionFingerprint === actionFingerprint,
    );
}

/** Advances one evidenced transient failure to a new durable plan before retry. */
export function advanceGovernorAgentLoopTransientFailure(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  sourceEffectId: string;
  now: number;
}): GovernorAgentLoopTransientFailureResult {
  const task = params.controller.store.loadTask(params.taskId);
  const effect = failedCurrentEffect(params.controller, params.taskId, params.sourceEffectId);
  if (!task || !effect || task.state === "COMPLETED" || task.state === "BLOCKED") {
    return { kind: "not_eligible" };
  }
  if (task.state !== "EXECUTING" && task.state !== "REPLAN_REQUIRED" && task.state !== "READY") {
    return { kind: "not_eligible" };
  }
  if (
    effect.objectiveRevision !== task.objectiveRevision ||
    effect.executionGeneration !== task.executionGeneration ||
    hasCurrentEvidence(params.controller, params.taskId, task.planVersion, effect.criterionId)
  ) {
    return { kind: "not_eligible" };
  }
  const prior = priorCause(params.controller, params.taskId, effect.actionFingerprint);
  const id = checkpointId(effect);
  if (prior && prior.sourceEffectId !== effect.effectId) {
    return { kind: "retry_exhausted" };
  }
  if (prior && task.planVersion > effect.planVersion) {
    return { kind: "retry_exhausted" };
  }
  const fromPlanVersion = effect.planVersion;
  if (!prior) {
    params.controller.requestRuntimeReplan(params.taskId, params.now, "tool_semantic_failure", {
      sourceEffectId: effect.effectId,
      actionFingerprint: effect.actionFingerprint,
      checkpointId: id,
      fromPlanVersion,
    });
  }
  const current = params.controller.store.loadTask(params.taskId);
  if (!current) {
    return { kind: "not_eligible" };
  }
  const checkpointed = params.controller.store
    .listEvents(params.taskId)
    .some((event) => payloadRecord(event.payload)?.checkpointId === id);
  if (!checkpointed) {
    params.controller.recordCheckpoint({
      taskId: params.taskId,
      checkpointId: id,
      verifiedFacts: [],
      discardedAssumptions: [`failed-effect:${effect.effectId}`],
      unresolvedQuestions: [effect.criterionId ?? effect.actionFingerprint],
      nextDiscriminatingAction: effect.criterionId ?? effect.capability ?? "retry",
      now: params.now + 1,
    });
  }
  const afterCheckpoint = params.controller.store.loadTask(params.taskId);
  if (!afterCheckpoint) {
    return { kind: "not_eligible" };
  }
  if (afterCheckpoint.planVersion === fromPlanVersion) {
    const planned = params.controller.preparePlan({
      taskId: params.taskId,
      plan: buildGovernorAgentLoopPlan(afterCheckpoint),
      now: params.now + 2,
    });
    params.controller.startExecution(params.taskId, params.now + 6);
    return {
      kind: "replanned",
      checkpointId: id,
      fromPlanVersion,
      planVersion: planned.planVersion,
    };
  }
  if (afterCheckpoint.state === "READY") {
    params.controller.startExecution(params.taskId, params.now + 6);
  }
  return { kind: "already_replanned", checkpointId: id, planVersion: afterCheckpoint.planVersion };
}

/** Repairs a crash between any durable failure/replan boundary before new model work. */
export function recoverGovernorAgentLoopTransientFailure(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  now: number;
}): GovernorAgentLoopTransientFailureResult | undefined {
  const task = params.controller.store.loadTask(params.taskId);
  if (task?.state === "PLANNING" && task.plan) {
    const plan = task.plan;
    const resumed = params.controller.preparePlan({
      taskId: params.taskId,
      plan,
      now: params.now,
    });
    return {
      kind: "replanned",
      checkpointId: `gcheckpoint_resume_${governorDigest({ taskId: params.taskId, planVersion: resumed.planVersion }).slice(0, 32)}`,
      fromPlanVersion: Math.max(0, resumed.planVersion - 1),
      planVersion: resumed.planVersion,
    };
  }
  if (
    !task ||
    (task.state !== "EXECUTING" && task.state !== "REPLAN_REQUIRED" && task.state !== "READY")
  ) {
    return undefined;
  }
  const effect = params.controller.store
    .listCurrentEffects(params.taskId)
    .toReversed()
    .find(
      (item) =>
        item.outcome.transport === "failed" && item.outcome.semantic === "transient_failure",
    );
  return effect
    ? advanceGovernorAgentLoopTransientFailure({
        controller: params.controller,
        taskId: params.taskId,
        sourceEffectId: effect.effectId,
        now: params.now,
      })
    : undefined;
}
