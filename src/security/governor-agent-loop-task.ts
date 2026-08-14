import type { GovernorActionIntent } from "../tasks/governor/action-intent.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId, GovernorTaskProjection } from "../tasks/governor/types.js";
import { buildGovernorAgentLoopPlan } from "./governor-agent-loop-plan.js";
import { safeGovernorAgentLoopValue } from "./governor-agent-loop-values.js";
import type { HostGovernorCapabilities } from "./governor-host-contracts.js";

export type GovernorAgentLoopTicketState = Readonly<{
  intent: GovernorActionIntent;
  workerId: string;
  claimEpoch: number;
  toolCallId: string;
  toolName: string;
  criterionId?: string;
  observationKey?: string;
}>;

export function ensureGovernorAgentLoopExecuting(
  controller: GovernorController,
  taskId: GovernorTaskId,
  now: number,
): GovernorTaskProjection {
  let task = controller.store.loadTask(taskId);
  if (!task) {
    throw new Error("GOVERNOR_AGENT_LOOP_TASK_UNAVAILABLE");
  }
  if (["RECEIVED", "CONTRACTING", "PLANNING", "REPLAN_REQUIRED"].includes(task.state)) {
    task = controller.preparePlan({
      taskId,
      plan: buildGovernorAgentLoopPlan(task),
      now,
    });
  }
  if (task.state === "READY") {
    task = controller.startExecution(taskId, now + 4);
  }
  if (task.state !== "EXECUTING" && task.state !== "COMPLETED") {
    throw new Error("GOVERNOR_AGENT_LOOP_TASK_STATE_INVALID");
  }
  return task;
}

export function recordGovernorAgentLoopToolObservation(params: {
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
  taskId: GovernorTaskId;
  state: GovernorAgentLoopTicketState;
  observation: Readonly<{
    toolName: string;
    result: unknown;
    isError: boolean;
    now: number;
  }>;
}): void {
  const safeResult = safeGovernorAgentLoopValue(params.observation.result);
  const resultDigest = governorDigest(safeResult);
  const currentTask = params.controller.store.loadTask(params.taskId);
  if (
    !currentTask ||
    currentTask.objectiveRevision !== params.state.intent.objectiveRevision ||
    currentTask.planVersion !== params.state.intent.planVersion
  ) {
    throw new Error("GOVERNOR_AGENT_LOOP_RESULT_STALE");
  }
  const evidence: GovernorJsonValue = {
    kind: "host_observed_tool_result",
    effectId: params.state.intent.effectId,
    toolName: params.observation.toolName,
    capability: params.state.intent.proposal.capability,
    capabilityVersion: params.state.intent.proposal.capabilityVersion,
    canonicalTarget: params.state.intent.proposal.canonicalTarget,
    toolImplementationDigest: params.state.intent.proposal.toolImplementationDigest ?? "absent",
    resultDigest,
    observationKey: params.state.observationKey ?? "none",
    dependsOnCriteria: [
      ...(currentTask.contract.completionCriteria.find(
        (criterion) => criterion.criterionId === params.state.criterionId,
      )?.dependsOnCriteria ?? []),
    ],
  };
  const receiptId = params.state.criterionId
    ? params.submitObservedReceipt({
        scopeKey: currentTask.scopeKey,
        taskId: params.state.intent.taskId,
        taskVersion: params.state.intent.taskVersion,
        objectiveRevision: params.state.intent.objectiveRevision,
        planVersion: params.state.intent.planVersion,
        sourceKind: "tool",
        sourceIdentity: params.state.intent.proposal.capability,
        payload: evidence,
        observedAt: params.observation.now,
      })
    : undefined;
  const recorded = params.controller.recordAdmittedToolOutcome({
    taskId: params.taskId,
    intent: params.state.intent,
    workerId: params.state.workerId,
    claimEpoch: params.state.claimEpoch,
    outcome: {
      transport: params.observation.isError ? "failed" : "completed",
      semantic: params.observation.isError ? "transient_failure" : "success",
      sideEffect: params.state.intent.proposal.mutating ? "unknown" : "none",
      verification: params.state.intent.proposal.mutating ? "required" : "not_required",
      summaryCode: params.observation.isError ? "tool_error" : "tool_success",
      ...(params.state.criterionId ? { evidence } : {}),
    },
    evidenceSourceKind: "tool",
    ...(receiptId ? { evidenceReceiptId: receiptId } : {}),
    now: params.observation.now,
  });
  if (!recorded.accepted) {
    throw new Error("GOVERNOR_AGENT_LOOP_RESULT_STALE");
  }
}

export function interruptGovernorAgentLoopTool(params: {
  controller: GovernorController;
  taskId: GovernorTaskId;
  state: GovernorAgentLoopTicketState;
  now: number;
}): void {
  const recorded = params.controller.recordAdmittedToolOutcome({
    taskId: params.taskId,
    intent: params.state.intent,
    workerId: params.state.workerId,
    claimEpoch: params.state.claimEpoch,
    outcome: {
      transport: "unknown",
      semantic: "cancelled",
      sideEffect: "none",
      verification: "not_required",
      summaryCode: "runtime_interrupted",
    },
    evidenceSourceKind: "tool",
    now: params.now,
  });
  if (recorded.accepted && recorded.task.state === "EXECUTING") {
    params.controller.requestRuntimeReplan(params.taskId, params.now + 1, "provider_interrupted");
  }
}
