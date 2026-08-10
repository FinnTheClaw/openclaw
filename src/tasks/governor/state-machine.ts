// Applies closed, version-and-lease-fenced behavior-governor transitions.
import type { GovernorTaskProjection, GovernorTaskState } from "./types.js";

const TERMINAL_STATES = new Set<GovernorTaskState>(["COMPLETED", "CANCELLED", "FAILED_FATAL"]);

const TRANSITIONS = {
  RECEIVED: ["CONTRACTING", "CANCELLED", "FAILED_FATAL"],
  CONTRACTING: [
    "PLANNING",
    "READY",
    "AWAITING_INPUT",
    "AWAITING_APPROVAL",
    "BLOCKED",
    "CANCELLED",
    "FAILED_FATAL",
  ],
  PLANNING: [
    "READY",
    "REPLAN_REQUIRED",
    "AWAITING_INPUT",
    "AWAITING_APPROVAL",
    "BLOCKED",
    "CANCELLED",
    "FAILED_FATAL",
  ],
  READY: ["EXECUTING", "REPLAN_REQUIRED", "CANCELLED", "FAILED_FATAL"],
  EXECUTING: [
    "VERIFYING",
    "REPLAN_REQUIRED",
    "AWAITING_INPUT",
    "AWAITING_APPROVAL",
    "BLOCKED",
    "CANCELLED",
    "FAILED_FATAL",
  ],
  VERIFYING: [
    "FINISH_CANDIDATE",
    "REPLAN_REQUIRED",
    "AWAITING_INPUT",
    "BLOCKED",
    "CANCELLED",
    "FAILED_FATAL",
  ],
  FINISH_CANDIDATE: ["COMPLETED", "REPLAN_REQUIRED", "BLOCKED", "CANCELLED", "FAILED_FATAL"],
  REPLAN_REQUIRED: [
    "PLANNING",
    "AWAITING_INPUT",
    "AWAITING_APPROVAL",
    "BLOCKED",
    "CANCELLED",
    "FAILED_FATAL",
  ],
  AWAITING_INPUT: ["CONTRACTING", "PLANNING", "READY", "CANCELLED", "FAILED_FATAL"],
  AWAITING_APPROVAL: ["PLANNING", "READY", "BLOCKED", "CANCELLED", "FAILED_FATAL"],
  BLOCKED: ["PLANNING", "READY", "CANCELLED", "FAILED_FATAL"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED_FATAL: [],
} satisfies Record<GovernorTaskState, readonly GovernorTaskState[]>;

export type GovernorTransitionResult =
  | { applied: true; task: GovernorTaskProjection }
  | {
      applied: false;
      reason: "task_version_conflict" | "lease_epoch_conflict" | "invalid_transition";
      current: GovernorTaskProjection;
    };

export function isGovernorTerminalState(state: GovernorTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function applyGovernorTransition(params: {
  task: GovernorTaskProjection;
  expectedTaskVersion: number;
  expectedLeaseEpoch: number;
  to: GovernorTaskState;
  now: number;
}): GovernorTransitionResult {
  if (params.task.taskVersion !== params.expectedTaskVersion) {
    return { applied: false, reason: "task_version_conflict", current: params.task };
  }
  if (params.task.leaseEpoch !== params.expectedLeaseEpoch) {
    return { applied: false, reason: "lease_epoch_conflict", current: params.task };
  }
  const allowedStates = TRANSITIONS[params.task.state] as readonly GovernorTaskState[];
  if (!allowedStates.includes(params.to)) {
    return { applied: false, reason: "invalid_transition", current: params.task };
  }
  return {
    applied: true,
    task: {
      ...params.task,
      state: params.to,
      taskVersion: params.task.taskVersion + 1,
      updatedAt: params.now,
      ...(isGovernorTerminalState(params.to) ? { terminalAt: params.now } : {}),
    },
  };
}

export type GovernorLeaseReclaimResult =
  | { applied: true; task: GovernorTaskProjection }
  | {
      applied: false;
      reason: "task_version_conflict" | "lease_epoch_conflict" | "terminal_task";
      current: GovernorTaskProjection;
    };

export function reclaimGovernorLease(params: {
  task: GovernorTaskProjection;
  expectedTaskVersion: number;
  expectedLeaseEpoch: number;
  now: number;
}): GovernorLeaseReclaimResult {
  if (params.task.taskVersion !== params.expectedTaskVersion) {
    return { applied: false, reason: "task_version_conflict", current: params.task };
  }
  if (params.task.leaseEpoch !== params.expectedLeaseEpoch) {
    return { applied: false, reason: "lease_epoch_conflict", current: params.task };
  }
  if (isGovernorTerminalState(params.task.state)) {
    return { applied: false, reason: "terminal_task", current: params.task };
  }
  return {
    applied: true,
    task: {
      ...params.task,
      taskVersion: params.task.taskVersion + 1,
      leaseEpoch: params.task.leaseEpoch + 1,
      executionGeneration: params.task.executionGeneration + 1,
      updatedAt: params.now,
    },
  };
}
