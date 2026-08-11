// Defines immutable behavior-governor event records.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import {
  createGovernorEventId,
  type GovernorEventId,
  type GovernorTaskId,
  type GovernorTaskProjection,
} from "./types.js";

export type GovernorEventType =
  | "task_received"
  | "task_corrected"
  | "task_conditions_updated"
  | "stale_ingress_ignored"
  | "state_transitioned"
  | "plan_replaced"
  | "action_admitted"
  | "checkpoint_recorded"
  | "tool_outcome_recorded"
  | "mutation_reconciled"
  | "late_tool_result_ignored"
  | "evidence_admitted"
  | "finish_rejected"
  | "completion_certified"
  | "lease_reclaimed"
  | "outbox_enqueued";

export type GovernorEventRecord = {
  eventId: GovernorEventId;
  taskId: GovernorTaskId;
  scopeKey: string;
  sourceMessageId?: string;
  sourceSequence?: number;
  eventType: GovernorEventType;
  taskVersion: number;
  objectiveRevision: number;
  payload: GovernorJsonValue;
  payloadDigest: string;
  createdAt: number;
};

export function createGovernorEventRecord(params: {
  task: GovernorTaskProjection;
  eventType: GovernorEventType;
  payload: GovernorJsonValue;
  now: number;
  eventId?: GovernorEventId;
  sourceMessageId?: string;
  sourceSequence?: number;
}): GovernorEventRecord {
  const payload = assertGovernorBoundarySafe("log", params.payload);
  return {
    eventId: params.eventId ?? createGovernorEventId(),
    taskId: params.task.taskId,
    scopeKey: params.task.scopeKey,
    ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
    ...(params.sourceSequence !== undefined ? { sourceSequence: params.sourceSequence } : {}),
    eventType: params.eventType,
    taskVersion: params.task.taskVersion,
    objectiveRevision: params.task.objectiveRevision,
    payload,
    payloadDigest: governorDigest(payload),
    createdAt: params.now,
  };
}
