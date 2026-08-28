import type { GovernorEffectRecord } from "../tasks/governor/action-contracts.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorC05FailureReplanBoundary } from "../tasks/governor/controller-runtime.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type {
  GovernorPlan,
  GovernorTaskId,
  GovernorTaskProjection,
} from "../tasks/governor/types.js";

type C05Mode = "shadow" | "enforce";
type C05Activation = Readonly<{ activationId: object; mode: C05Mode }>;

const activations = new Set<C05Activation>();

export type GovernorC05FailureReplanResult =
  | Readonly<{ kind: "replanned"; fromPlanVersion: number; planVersion: number }>
  | Readonly<{ kind: "already_replanned" }>
  | Readonly<{ kind: "not_eligible" }>;

function isEnforced(): boolean {
  return [...activations].some((activation) => activation.mode === "enforce");
}

function eventPayload(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function c05Payload(value: unknown): GovernorC05FailureReplanBoundary | undefined {
  const payload = eventPayload(value);
  const boundary = payload && eventPayload(payload.c05FailureReplan);
  if (
    !boundary ||
    boundary.moduleId !== "C05.FAILURE_REPLAN" ||
    typeof boundary.taskId !== "string" ||
    typeof boundary.sourceEffectId !== "string" ||
    (boundary.sourceCriterionId !== undefined && typeof boundary.sourceCriterionId !== "string") ||
    typeof boundary.checkpointId !== "string" ||
    !Number.isSafeInteger(boundary.fromPlanVersion) ||
    !Number.isSafeInteger(boundary.objectiveRevision) ||
    !Number.isSafeInteger(boundary.executionGeneration) ||
    boundary.expectedState !== "REPLAN_REQUIRED"
  ) {
    return undefined;
  }
  const disposition = eventPayload(boundary.effectDisposition);
  if (
    !disposition ||
    typeof disposition.mutating !== "boolean" ||
    !["not_applicable", "none", "applied", "unknown"].includes(String(disposition.sideEffect)) ||
    typeof disposition.reconcileRequired !== "boolean"
  ) {
    return undefined;
  }
  return boundary as GovernorC05FailureReplanBoundary;
}

function failedEffect(
  controller: GovernorController,
  task: GovernorTaskProjection,
  effectId: string,
): GovernorEffectRecord | undefined {
  return controller.store
    .listEffects(task.taskId)
    .find(
      (effect) =>
        effect.effectId === effectId &&
        effect.objectiveRevision === task.objectiveRevision &&
        effect.planVersion === task.planVersion &&
        effect.executionGeneration === task.executionGeneration &&
        effect.outcome.transport === "failed" &&
        effect.outcome.semantic === "transient_failure",
    );
}

function boundaryEffect(
  controller: GovernorController,
  task: GovernorTaskProjection,
  boundary: GovernorC05FailureReplanBoundary,
): GovernorEffectRecord | undefined {
  if (
    boundary.taskId !== task.taskId ||
    boundary.objectiveRevision !== task.objectiveRevision ||
    boundary.executionGeneration !== task.executionGeneration
  ) {
    return undefined;
  }
  return controller.store
    .listEffects(task.taskId)
    .find(
      (effect) =>
        effect.effectId === boundary.sourceEffectId &&
        effect.objectiveRevision === boundary.objectiveRevision &&
        effect.planVersion === boundary.fromPlanVersion &&
        effect.executionGeneration === boundary.executionGeneration &&
        effect.outcome.transport === "failed" &&
        effect.outcome.semantic === "transient_failure" &&
        effect.mutating === boundary.effectDisposition.mutating &&
        effect.outcome.sideEffect === boundary.effectDisposition.sideEffect &&
        effect.reconcileRequired === boundary.effectDisposition.reconcileRequired,
    );
}

function checkpointId(task: GovernorTaskProjection, effect: GovernorEffectRecord): string {
  return `gcheckpoint_${governorDigest({
    taskId: task.taskId,
    objectiveRevision: task.objectiveRevision,
    executionGeneration: task.executionGeneration,
    fromPlanVersion: task.planVersion,
    effectId: effect.effectId,
  }).slice(0, 48)}`;
}

function boundaryFor(
  task: GovernorTaskProjection,
  effect: GovernorEffectRecord,
): GovernorC05FailureReplanBoundary {
  return {
    moduleId: "C05.FAILURE_REPLAN",
    taskId: task.taskId,
    sourceEffectId: effect.effectId,
    ...(effect.criterionId ? { sourceCriterionId: effect.criterionId } : {}),
    checkpointId: checkpointId(task, effect),
    fromPlanVersion: task.planVersion,
    objectiveRevision: task.objectiveRevision,
    executionGeneration: task.executionGeneration,
    expectedState: "REPLAN_REQUIRED",
    effectDisposition: {
      mutating: effect.mutating,
      sideEffect: effect.outcome.sideEffect,
      reconcileRequired: effect.reconcileRequired,
    },
  };
}

function matchingBoundary(
  controller: GovernorController,
  task: GovernorTaskProjection,
): GovernorC05FailureReplanBoundary | undefined {
  const matches = controller.store
    .listEvents(task.taskId)
    .filter(
      (event) =>
        event.eventType === "runtime_replan_requested" &&
        event.taskId === task.taskId &&
        event.scopeKey === task.scopeKey &&
        event.objectiveRevision === task.objectiveRevision,
    )
    .map((event) => c05Payload(event.payload))
    .filter((value): value is GovernorC05FailureReplanBoundary => value !== undefined)
    .filter((boundary) => boundaryEffect(controller, task, boundary) !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function planFor(
  task: GovernorTaskProjection,
  boundary: GovernorC05FailureReplanBoundary,
): GovernorPlan {
  const preventRetry =
    boundary.effectDisposition.mutating &&
    boundary.effectDisposition.sideEffect !== "none" &&
    boundary.effectDisposition.sideEffect !== "not_applicable";
  const criteria = task.contract.completionCriteria.filter(
    (criterion) => !preventRetry || criterion.criterionId !== boundary.sourceCriterionId,
  );
  const known = new Set(criteria.map((criterion) => criterion.criterionId));
  const stepByCriterion = new Map(
    criteria.map((criterion, index) => [criterion.criterionId, `runtime-step-${index + 1}`]),
  );
  const dag = criteria.some((criterion) => (criterion.dependsOnCriteria?.length ?? 0) > 0);
  return {
    kind: dag ? "dag" : "ordered",
    steps: criteria.map((criterion, index) => ({
      stepId: `runtime-step-${index + 1}`,
      description: `Satisfy ${criterion.criterionId}`,
      criterionIds: [criterion.criterionId],
      dependsOn: (criterion.dependsOnCriteria ?? [])
        .filter((id) => known.has(id))
        .map((id) => stepByCriterion.get(id)!)
        .toSorted(),
    })),
  };
}

function hasCheckpoint(
  controller: GovernorController,
  taskId: GovernorTaskId,
  checkpoint: string,
): boolean {
  return controller.store.listEvents(taskId).some((event) => {
    const payload = eventPayload(event.payload);
    return event.eventType === "checkpoint_recorded" && payload?.checkpointId === checkpoint;
  });
}

function recordCheckpoint(
  controller: GovernorController,
  task: GovernorTaskProjection,
  effect: GovernorEffectRecord,
  boundary: GovernorC05FailureReplanBoundary,
  now: number,
): void {
  if (hasCheckpoint(controller, task.taskId, boundary.checkpointId)) {
    return;
  }
  controller.recordCheckpoint({
    taskId: task.taskId,
    checkpointId: boundary.checkpointId,
    verifiedFacts: [],
    discardedAssumptions: [`failed-effect:${effect.effectId}`],
    unresolvedQuestions: [effect.criterionId ?? effect.capability ?? "retry"],
    nextDiscriminatingAction: effect.criterionId ?? effect.capability ?? "retry",
    now,
  });
}

function result(boundary: GovernorC05FailureReplanBoundary): GovernorC05FailureReplanResult {
  return {
    kind: "replanned",
    fromPlanVersion: boundary.fromPlanVersion,
    planVersion: boundary.fromPlanVersion + 1,
  };
}

/** Replays only C05's own exact boundary, never an unrelated plan transition. */
function finishBoundary(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  boundary: GovernorC05FailureReplanBoundary;
  now: number;
}): GovernorC05FailureReplanResult {
  let task = params.controller.store.loadTask(params.taskId);
  if (!task) {
    return { kind: "not_eligible" };
  }
  const effect = boundaryEffect(params.controller, task, params.boundary);
  if (!effect) {
    return { kind: "not_eligible" };
  }
  if (task.planVersion === params.boundary.fromPlanVersion + 1) {
    if (task.state === "EXECUTING") {
      return { kind: "already_replanned" };
    }
    if (task.state === "READY") {
      params.controller.startExecution(params.taskId, params.now + 6);
      return result(params.boundary);
    }
    return { kind: "not_eligible" };
  }
  if (task.planVersion !== params.boundary.fromPlanVersion) {
    return { kind: "not_eligible" };
  }
  if (task.state === "REPLAN_REQUIRED" || task.state === "PLANNING") {
    recordCheckpoint(params.controller, task, effect, params.boundary, params.now + 1);
    task = params.controller.preparePlan({
      taskId: params.taskId,
      plan: planFor(task, params.boundary),
      now: params.now + 2,
    });
  }
  if (task.state === "READY" && task.planVersion === params.boundary.fromPlanVersion + 1) {
    params.controller.startExecution(params.taskId, params.now + 6);
    return result(params.boundary);
  }
  return { kind: "not_eligible" };
}

/** C05 owns one durable replan boundary for a failed effect, never a retry. */
export function advanceGovernorC05FailureReplan(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  sourceEffectId: string;
  now: number;
}): GovernorC05FailureReplanResult {
  if (!isEnforced()) {
    return { kind: "not_eligible" };
  }
  const task = params.controller.store.loadTask(params.taskId);
  if (!task || task.state !== "EXECUTING") {
    return { kind: "not_eligible" };
  }
  const effect = failedEffect(params.controller, task, params.sourceEffectId);
  if (!effect) {
    return { kind: "not_eligible" };
  }
  const existing = matchingBoundary(params.controller, task);
  if (existing) {
    return finishBoundary({ ...params, boundary: existing });
  }
  const boundary = boundaryFor(task, effect);
  params.controller.requestRuntimeReplan(params.taskId, params.now, {
    reasonCode: "tool_semantic_failure",
    sourceEffectId: effect.effectId,
    checkpointId: boundary.checkpointId,
    c05FailureReplan: boundary,
  });
  return finishBoundary({ ...params, boundary });
}

/** Includes EXECUTING-after-observation; a foreign PLANNING/REPLAN is ignored. */
export function recoverGovernorC05FailureReplan(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  now: number;
}): GovernorC05FailureReplanResult | undefined {
  if (!isEnforced()) {
    return undefined;
  }
  const task = params.controller.store.loadTask(params.taskId);
  if (!task) {
    return undefined;
  }
  const boundary = matchingBoundary(params.controller, task);
  if (boundary) {
    return finishBoundary({ ...params, boundary });
  }
  if (task.state !== "EXECUTING") {
    return undefined;
  }
  const candidates = params.controller.store
    .listEffects(task.taskId)
    .filter((effect) => failedEffect(params.controller, task, effect.effectId) !== undefined);
  if (candidates.length !== 1) {
    return undefined;
  }
  return advanceGovernorC05FailureReplan({
    controller: params.controller,
    taskId: params.taskId,
    sourceEffectId: candidates[0]!.effectId,
    now: params.now,
  });
}

/** Lifecycle-owned activation avoids a close in one runtime clearing another. */
export function installGovernorC05FailureReplan(params: C05Activation): { close: () => void } {
  activations.add(params);
  return Object.freeze({ close: () => activations.delete(params) });
}
