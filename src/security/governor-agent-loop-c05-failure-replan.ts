import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type {
  GovernorPlan,
  GovernorTaskId,
  GovernorTaskProjection,
} from "../tasks/governor/types.js";

type C05Mode = "shadow" | "enforce";
type ActiveC05 = Readonly<{ mode: C05Mode; token: object }>;
let active: ActiveC05 | undefined;

export type GovernorC05FailureReplanResult =
  | Readonly<{ kind: "replanned"; fromPlanVersion: number; planVersion: number }>
  | Readonly<{ kind: "already_replanned" }>
  | Readonly<{ kind: "not_eligible" }>;

function planFor(task: GovernorTaskProjection): GovernorPlan {
  const stepByCriterion = new Map(
    task.contract.completionCriteria.map((criterion, index) => [
      criterion.criterionId,
      `runtime-step-${index + 1}`,
    ]),
  );
  const dag = task.contract.completionCriteria.some(
    (criterion) => (criterion.dependsOnCriteria?.length ?? 0) > 0,
  );
  return {
    kind: dag ? "dag" : "ordered",
    steps: task.contract.completionCriteria.map((criterion, index) => ({
      stepId: `runtime-step-${index + 1}`,
      description: `Satisfy ${criterion.criterionId}`,
      criterionIds: [criterion.criterionId],
      dependsOn: criterion.dependsOnCriteria?.length
        ? criterion.dependsOnCriteria.map((id) => stepByCriterion.get(id)!).toSorted()
        : dag || index === 0
          ? []
          : [`runtime-step-${index}`],
    })),
  };
}

function eventPayload(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasReplanFor(
  controller: GovernorController,
  taskId: GovernorTaskId,
  effectId: string,
): boolean {
  return controller.store.listEvents(taskId).some((event) => {
    const payload = eventPayload(event.payload);
    return event.eventType === "runtime_replan_requested" && payload?.sourceEffectId === effectId;
  });
}

function failedEffect(controller: GovernorController, taskId: GovernorTaskId, effectId: string) {
  const effect = controller.store.loadEffect(taskId, effectId);
  return effect?.outcome.transport === "failed" && effect.outcome.semantic === "transient_failure"
    ? effect
    : undefined;
}

function checkpointId(task: GovernorTaskProjection, effectId: string): string {
  return `gcheckpoint_${governorDigest({
    taskId: task.taskId,
    executionGeneration: task.executionGeneration,
    fromPlanVersion: task.planVersion,
    effectId,
  }).slice(0, 48)}`;
}

/** C05 owns one durable replan for a recorded transient effect, never a retry itself. */
export function advanceGovernorC05FailureReplan(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  sourceEffectId: string;
  now: number;
}): GovernorC05FailureReplanResult {
  if (active?.mode !== "enforce") return { kind: "not_eligible" };
  const task = params.controller.store.loadTask(params.taskId);
  const effect = failedEffect(params.controller, params.taskId, params.sourceEffectId);
  if (!task || !effect || task.state === "BLOCKED" || task.state === "COMPLETED")
    return { kind: "not_eligible" };
  if (hasReplanFor(params.controller, params.taskId, effect.effectId))
    return { kind: "already_replanned" };
  if (task.state !== "EXECUTING") return { kind: "not_eligible" };
  const fromPlanVersion = task.planVersion;
  const id = checkpointId(task, effect.effectId);
  params.controller.requestRuntimeReplan(params.taskId, params.now, {
    reasonCode: "tool_semantic_failure",
    sourceEffectId: effect.effectId,
    checkpointId: id,
  });
  params.controller.recordCheckpoint({
    taskId: params.taskId,
    checkpointId: id,
    verifiedFacts: [],
    discardedAssumptions: [`failed-effect:${effect.effectId}`],
    unresolvedQuestions: [effect.criterionId ?? effect.capability ?? "retry"],
    nextDiscriminatingAction: effect.criterionId ?? effect.capability ?? "retry",
    now: params.now + 1,
  });
  const replanning = params.controller.store.loadTask(params.taskId);
  if (!replanning || replanning.state !== "REPLAN_REQUIRED") return { kind: "not_eligible" };
  const planned = params.controller.preparePlan({
    taskId: params.taskId,
    plan: planFor(replanning),
    now: params.now + 2,
  });
  params.controller.startExecution(params.taskId, params.now + 6);
  return { kind: "replanned", fromPlanVersion, planVersion: planned.planVersion };
}

/** Replays only an unfinished C05 boundary; READY never becomes N+2. */
export function recoverGovernorC05FailureReplan(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  now: number;
}): GovernorC05FailureReplanResult | undefined {
  if (active?.mode !== "enforce") return undefined;
  const task = params.controller.store.loadTask(params.taskId);
  if (!task || (task.state !== "PLANNING" && task.state !== "REPLAN_REQUIRED")) return undefined;
  const planned = params.controller.preparePlan({
    taskId: params.taskId,
    plan: planFor(task),
    now: params.now,
  });
  params.controller.startExecution(params.taskId, params.now + 4);
  return {
    kind: "replanned",
    fromPlanVersion: planned.planVersion - 1,
    planVersion: planned.planVersion,
  };
}

export function installGovernorC05FailureReplan(mode: C05Mode): { close: () => void } {
  const token = {};
  active = { mode, token };
  return Object.freeze({
    close: () => {
      if (active?.token === token) active = undefined;
    },
  });
}
