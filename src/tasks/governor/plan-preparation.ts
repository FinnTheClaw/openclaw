import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertValidGovernorPlan } from "./contracts.js";
import { createGovernorEventRecord } from "./events.js";
import { prepareGovernorPlanReplacement } from "./plan-replacement.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorPlan, GovernorTaskProjection, GovernorTaskState } from "./types.js";

function assertApplied(result: import("./store.js").GovernorCommitResult): GovernorTaskProjection {
  if (!result.applied) {
    throw new Error("GOVERNOR_COMMIT_REJECTED");
  }
  return result.task;
}

export function prepareGovernorPlan(params: {
  task: GovernorTaskProjection;
  plan: GovernorPlan;
  now: number;
  store: GovernorSqliteStore;
  transition: (
    task: GovernorTaskProjection,
    to: GovernorTaskState,
    now: number,
  ) => GovernorTaskProjection;
}): GovernorTaskProjection {
  let task = params.task;
  const plan = assertGovernorBoundarySafe(
    "session",
    params.plan as unknown as GovernorJsonValue,
  ) as unknown as GovernorPlan;
  assertValidGovernorPlan(plan, task.contract);
  if (task.state === "RECEIVED") {
    task = params.transition(task, "CONTRACTING", params.now);
  }
  if (task.state === "CONTRACTING" || task.state === "REPLAN_REQUIRED") {
    task = params.transition(task, "PLANNING", params.now + 1);
  }
  if (task.state !== "PLANNING") {
    throw new Error("GOVERNOR_PLAN_STATE_INVALID");
  }
  const planDigest = governorDigest(plan as unknown as GovernorJsonValue);
  const resumedReplacement = params.store.listEvents(task.taskId).findLast((event) => {
    const payload = event.payload;
    return (
      event.eventType === "plan_replaced" &&
      event.taskVersion === task.taskVersion &&
      event.objectiveRevision === task.objectiveRevision &&
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      payload.planDigest === planDigest &&
      payload.planVersion === task.planVersion
    );
  });
  if (
    resumedReplacement &&
    task.plan &&
    governorDigest(task.plan as unknown as GovernorJsonValue) === planDigest
  ) {
    return params.transition(task, "READY", params.now + 3);
  }
  const replacement = prepareGovernorPlanReplacement({
    store: params.store,
    task,
    plan,
    now: params.now,
  });
  const event = createGovernorEventRecord({
    task: replacement.task,
    eventType: "plan_replaced",
    payload: {
      kind: plan.kind,
      stepCount: plan.steps.length,
      planDigest,
      planVersion: replacement.task.planVersion,
      carriedForwardEvidenceCount: replacement.evidenceAdmissions.length,
      carriedForwardEvidenceIds: replacement.evidenceAdmissions.map(
        (item) => item.evidence.evidenceId,
      ),
    },
    now: params.now + 2,
  });
  return assertApplied(
    params.store.commit({
      current: task,
      next: replacement.task,
      event,
      ...(replacement.evidenceAdmissions.length
        ? { evidenceAdmissions: replacement.evidenceAdmissions }
        : {}),
    }),
  );
}
