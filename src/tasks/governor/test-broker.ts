// Synthetic host bootstrap for governor tests only. Never import from runtime code.
import { createGovernorTestHostBindings } from "../../security/governor-host-readonly.js";
import type {
  GovernorRecordAdmittedToolOutcomeParams,
  GovernorRecordToolOutcomeParams,
} from "./action-runtime.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import type { GovernorController } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";

export function createGovernorTestBroker() {
  return createGovernorTestHostBindings();
}

export function createGovernorTestStore(params: { stateDir?: string } = {}) {
  const broker = createGovernorTestBroker();
  return {
    broker,
    store: new GovernorSqliteStore({
      ...params,
      receiptResolver: broker.resolver,
      approvalResolver: broker.approvalResolver,
      deliveryResolver: broker.deliveryResolver,
    }),
  };
}

/** Issues the exact trusted receipt that the inline action runtime will admit. */
export function recordGovernorTestToolOutcome(
  controller: GovernorController,
  broker: ReturnType<typeof createGovernorTestBroker>,
  params: GovernorRecordToolOutcomeParams,
) {
  const needsEvidence =
    params.proposal.criterionId &&
    params.outcome.transport === "completed" &&
    params.outcome.semantic === "success" &&
    (!params.proposal.mutating || params.outcome.verification === "verified") &&
    params.outcome.evidence !== undefined &&
    params.evidenceSourceKind !== "assistant_text" &&
    params.evidenceSourceKind !== "hidden_reasoning";
  if (!needsEvidence) return controller.recordToolOutcome(params);
  const task = controller.store.loadTask(params.taskId);
  if (!task) throw new Error(`Governor task not found: ${params.taskId}`);
  const receiptId = broker.capabilities.submitObservedReceipt({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    // Inline admission first advances the task projection, and the intent
    // deliberately binds evidence to that post-admission version.
    taskVersion: task.taskVersion + 1,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    sourceKind: (params.evidenceSourceKind ?? "tool") as
      | "tool"
      | "structured_external"
      | "authenticated_user",
    sourceIdentity: params.proposal.capability,
    payload: params.outcome.evidence,
    observedAt: params.now,
  });
  return controller.recordToolOutcome({ ...params, evidenceReceiptId: receiptId });
}

/** Records an already-claimed test action with its host-issued evidence receipt. */
export function recordGovernorTestAdmittedToolOutcome(
  controller: GovernorController,
  broker: ReturnType<typeof createGovernorTestBroker>,
  params: GovernorRecordAdmittedToolOutcomeParams,
) {
  const needsEvidence =
    params.intent.proposal.criterionId &&
    params.outcome.transport === "completed" &&
    params.outcome.semantic === "success" &&
    (!params.intent.proposal.mutating || params.outcome.verification === "verified") &&
    params.outcome.evidence !== undefined &&
    params.evidenceSourceKind !== "assistant_text" &&
    params.evidenceSourceKind !== "hidden_reasoning";
  if (!needsEvidence) return controller.recordAdmittedToolOutcome(params);
  const task = controller.store.loadTask(params.taskId);
  if (!task) throw new Error(`Governor task not found: ${params.taskId}`);
  const receiptId = broker.capabilities.submitObservedReceipt({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    taskVersion: params.intent.taskVersion,
    objectiveRevision: params.intent.objectiveRevision,
    planVersion: params.intent.planVersion,
    sourceKind: (params.evidenceSourceKind ?? "tool") as
      | "tool"
      | "structured_external"
      | "authenticated_user",
    sourceIdentity: params.intent.proposal.capability,
    payload: params.outcome.evidence,
    observedAt: params.now,
  });
  return controller.recordAdmittedToolOutcome({ ...params, evidenceReceiptId: receiptId });
}

/** Resolves a mutation using a receipt tied to the exact current task scope. */
export function resolveGovernorTestMutation(
  controller: GovernorController,
  broker: ReturnType<typeof createGovernorTestBroker>,
  params: Parameters<GovernorController["resolveMutation"]>[0],
) {
  const task = controller.store.loadTask(params.taskId);
  if (!task) throw new Error(`Governor task not found: ${params.taskId}`);
  const receiptId = broker.capabilities.submitObservedReceipt({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    sourceKind: "structured_external",
    sourceIdentity: params.sourceIdentity,
    payload: params.evidence as GovernorJsonValue,
    observedAt: params.now,
  });
  return controller.resolveMutation({ ...params, evidenceReceiptId: receiptId });
}
