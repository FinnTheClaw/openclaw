import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
import { createGovernorEventRecord, type GovernorEventType } from "./events.js";
import { evaluateGovernorFinish, type GovernorFinishDecision } from "./finish-gate.js";
import { assertGovernorResponseDraft, type GovernorResponseDraft } from "./material-claims.js";
import { applyGovernorTransition } from "./state-machine.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

type GovernorRuntimeEventType = Extract<
  GovernorEventType,
  | "runtime_model_turn_recorded"
  | "runtime_tool_proposed"
  | "runtime_tool_observed"
  | "runtime_finish_proposed"
  | "runtime_replan_requested"
>;

export type GovernorRuntimeEventRequest = Readonly<{
  taskId: GovernorTaskId;
  eventType: GovernorRuntimeEventType;
  payload: GovernorJsonValue;
  now: number;
}>;

export type GovernorRuntimeReplanReason = "semantic_stagnation" | "tool_semantic_failure";
export type GovernorRuntimeTransitionReason = GovernorRuntimeReplanReason | "provider_interrupted";
export type GovernorRuntimeBlockReason =
  | "budget_exhausted"
  | "semantic_stagnation"
  | "tool_semantic_failure"
  | "shadow_observed";

export type GovernorRuntimeReplanGuidanceRequest = Readonly<{
  reasonCode: GovernorRuntimeReplanReason;
  progressDigest: string;
  sourceEffectId?: string;
}>;

export type GovernorRuntimeFinishRequest = Readonly<{
  taskId: GovernorTaskId;
  response: GovernorResponseDraft;
  now: number;
}>;

export function blockGovernorRuntimeTask(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  now: number,
  reasonCode: GovernorRuntimeBlockReason,
): GovernorTaskProjection {
  if (task.state === "BLOCKED") {
    return task;
  }
  if (task.state !== "EXECUTING") {
    throw new Error("GOVERNOR_RUNTIME_BLOCK_STATE_INVALID");
  }
  const transition = applyGovernorTransition({
    task,
    expectedTaskVersion: task.taskVersion,
    expectedLeaseEpoch: task.leaseEpoch,
    to: "BLOCKED",
    now,
  });
  if (!transition.applied) {
    throw new Error("GOVERNOR_RUNTIME_BLOCK_REJECTED");
  }
  const event = createGovernorEventRecord({
    task: transition.task,
    eventType: "state_transitioned",
    payload: { from: task.state, to: "BLOCKED", reasonCode },
    now,
  });
  const committed = store.commit({ current: task, next: transition.task, event });
  if (!committed.applied) {
    throw new Error("GOVERNOR_COMMIT_REJECTED");
  }
  return committed.task;
}

export function recordGovernorRuntimeEvent(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  request: GovernorRuntimeEventRequest,
): GovernorTaskProjection {
  const event = createGovernorEventRecord({ task, ...request });
  if (!store.appendAuditEvent({ task, event })) {
    throw new Error("GOVERNOR_RUNTIME_EVENT_STALE");
  }
  return task;
}

export function requestGovernorRuntimeReplan(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  now: number,
  reasonCode: GovernorRuntimeTransitionReason = "tool_semantic_failure",
): GovernorTaskProjection {
  if (task.state !== "EXECUTING") {
    throw new Error("GOVERNOR_RUNTIME_REPLAN_STATE_INVALID");
  }
  const transition = applyGovernorTransition({
    task,
    expectedTaskVersion: task.taskVersion,
    expectedLeaseEpoch: task.leaseEpoch,
    to: "REPLAN_REQUIRED",
    now,
  });
  if (!transition.applied) {
    throw new Error("GOVERNOR_RUNTIME_REPLAN_REJECTED");
  }
  const event = createGovernorEventRecord({
    task: transition.task,
    eventType: "runtime_replan_requested",
    payload: { reasonCode },
    now,
  });
  const committed = store.commit({ current: task, next: transition.task, event });
  if (!committed.applied) {
    throw new Error("GOVERNOR_COMMIT_REJECTED");
  }
  return committed.task;
}

export function recordGovernorRuntimeReplanGuidance(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  now: number,
  request: GovernorRuntimeReplanGuidanceRequest,
): GovernorTaskProjection {
  if (task.state !== "EXECUTING") {
    throw new Error("GOVERNOR_RUNTIME_REPLAN_STATE_INVALID");
  }
  const guidanceRevision = governorDigest({
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    executionGeneration: task.executionGeneration,
    reasonCode: request.reasonCode,
    progressDigest: request.progressDigest,
    sourceEffectId: request.sourceEffectId ?? null,
  });
  const existing = store.listEvents(task.taskId).some((event) => {
    const payload = event.payload;
    return (
      event.eventType === "runtime_replan_requested" &&
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      payload.guidanceOnly === true &&
      payload.guidanceRevision === guidanceRevision
    );
  });
  if (existing) {
    return task;
  }
  const event = createGovernorEventRecord({
    task,
    eventType: "runtime_replan_requested",
    payload: {
      reasonCode: request.reasonCode,
      progressDigest: request.progressDigest,
      guidanceOnly: true,
      guidanceRevision,
      ...(request.sourceEffectId ? { sourceEffectId: request.sourceEffectId } : {}),
    },
    now,
  });
  if (!store.appendAuditEvent({ task, event })) {
    throw new Error("GOVERNOR_RUNTIME_EVENT_STALE");
  }
  return task;
}

export function assessGovernorRuntimeFinish(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  request: GovernorRuntimeFinishRequest,
): GovernorFinishDecision {
  const response = assertGovernorResponseDraft(request.response);
  const runningActionIds = [
    ...store.actionIntents.listPendingIds(task.taskId, task.objectiveRevision, request.now),
    ...store.listUnfinishedFanoutJobIds(task),
  ].toSorted();
  return evaluateGovernorFinish({
    task,
    effects: store.listCurrentEffects(task.taskId),
    evidence: store.listEvidence(task.taskId),
    runningActionIds,
    response,
    now: request.now,
  });
}
