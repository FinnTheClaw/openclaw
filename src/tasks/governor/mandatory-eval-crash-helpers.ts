// Focused helpers for deterministic mandatory crash/reconciliation scenarios.
import { governorActionTerminationReceiptPayload } from "./action-execution-lifecycle.js";
import type { GovernorActionIntent } from "./action-intent.js";
import type { GovernorController } from "./controller.js";
import type { createGovernorTestStore } from "./test-broker.js";

export function reconcileMandatoryUnknownMutation(params: {
  controller: GovernorController;
  capabilities: ReturnType<typeof createGovernorTestStore>["broker"]["capabilities"];
  taskId: GovernorActionIntent["taskId"];
  scopeKey: string;
  intent: GovernorActionIntent;
  observedAt: number;
}): void {
  const unknownPayload = governorActionTerminationReceiptPayload(params.intent, "unknown");
  const unknownReceipt = params.capabilities.submitObservedReceipt({
    scopeKey: params.scopeKey,
    taskId: params.taskId,
    taskVersion: params.intent.taskVersion,
    objectiveRevision: params.intent.objectiveRevision,
    planVersion: params.intent.planVersion,
    sourceKind: "structured_external",
    sourceIdentity: "synthetic-mutation-runner",
    payload: unknownPayload,
    observedAt: params.observedAt,
  });
  const unknown = params.controller.acknowledgeActionTermination({
    taskId: params.taskId,
    effectId: params.intent.effectId,
    receiptId: unknownReceipt,
    outcome: "unknown",
    now: params.observedAt,
  });
  if (unknown.kind !== "acknowledged") {
    throw new Error("Unknown action termination was not acknowledged");
  }
  const resolutionPayload = governorActionTerminationReceiptPayload(
    unknown.intent,
    "confirmed_applied",
  );
  const resolutionReceipt = params.capabilities.submitObservedReceipt({
    scopeKey: params.scopeKey,
    taskId: params.taskId,
    taskVersion: unknown.intent.taskVersion,
    objectiveRevision: unknown.intent.objectiveRevision,
    planVersion: unknown.intent.planVersion,
    sourceKind: "structured_external",
    sourceIdentity: "synthetic-mutation-reconciler",
    payload: resolutionPayload,
    observedAt: params.observedAt + 1,
  });
  const resolved = params.controller.acknowledgeActionTermination({
    taskId: params.taskId,
    effectId: unknown.intent.effectId,
    receiptId: resolutionReceipt,
    outcome: "confirmed_applied",
    now: params.observedAt + 1,
  });
  if (resolved.kind !== "acknowledged") {
    throw new Error("Action termination reconciliation was not acknowledged");
  }
}
