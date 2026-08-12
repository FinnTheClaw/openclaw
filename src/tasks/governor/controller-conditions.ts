import { createGovernorEventRecord } from "./events.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskContradiction, GovernorTaskId, GovernorTaskProjection } from "./types.js";

export type GovernorPendingUpdateRequest = Readonly<{
  taskId: GovernorTaskId;
  pending: boolean;
  now: number;
}>;

export type GovernorContradictionRequest = Readonly<{
  taskId: GovernorTaskId;
  contradiction: GovernorTaskContradiction;
  now: number;
}>;

function nextVersion(task: GovernorTaskProjection, now: number): GovernorTaskProjection {
  return { ...task, taskVersion: task.taskVersion + 1, updatedAt: now };
}

function commit(
  store: GovernorSqliteStore,
  current: GovernorTaskProjection,
  next: GovernorTaskProjection,
  event: ReturnType<typeof createGovernorEventRecord>,
): GovernorTaskProjection {
  const result = store.commit({ current, next, event });
  if (!result.applied) {
    throw new Error("GOVERNOR_COMMIT_REJECTED");
  }
  return result.task;
}

export function setGovernorPendingUserUpdate(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  request: GovernorPendingUpdateRequest,
): GovernorTaskProjection {
  const next = {
    ...nextVersion(task, request.now),
    conditions: { ...task.conditions, pendingUserUpdate: request.pending },
  };
  const event = createGovernorEventRecord({
    task: next,
    eventType: "task_conditions_updated",
    payload: { pendingUserUpdate: request.pending },
    now: request.now,
  });
  return commit(store, task, next, event);
}

export function recordGovernorContradiction(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  request: GovernorContradictionRequest,
): GovernorTaskProjection {
  const safe = assertGovernorBoundarySafe(
    "log",
    request.contradiction,
  ) as GovernorTaskContradiction;
  const contradiction: GovernorTaskContradiction = {
    ...safe,
    sourceRef: store.opaqueReference("contradiction-source", safe.sourceRef),
  };
  const next = {
    ...nextVersion(task, request.now),
    conditions: {
      ...task.conditions,
      contradictions: [...task.conditions.contradictions, contradiction],
    },
  };
  const event = createGovernorEventRecord({
    task: next,
    eventType: "task_conditions_updated",
    payload: { contradictionId: contradiction.contradictionId, severity: contradiction.severity },
    now: request.now,
  });
  return commit(store, task, next, event);
}

export function resolveGovernorContradiction(
  store: GovernorSqliteStore,
  task: GovernorTaskProjection,
  contradictionId: string,
  now: number,
): GovernorTaskProjection {
  const next = {
    ...nextVersion(task, now),
    conditions: {
      ...task.conditions,
      contradictions: task.conditions.contradictions.filter(
        (item) => item.contradictionId !== contradictionId,
      ),
    },
  };
  const event = createGovernorEventRecord({
    task: next,
    eventType: "task_conditions_updated",
    payload: { resolvedContradictionId: contradictionId },
    now,
  });
  return commit(store, task, next, event);
}
