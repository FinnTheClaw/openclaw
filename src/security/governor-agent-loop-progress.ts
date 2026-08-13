/** Evidence-derived progress and eligible-action guidance for the host loop. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";

export type GovernorAgentLoopProgressAction = Readonly<{
  toolName: string;
  criterionId?: string;
  purpose: string;
  arguments: Readonly<Record<string, string>>;
}>;

export type GovernorAgentLoopProgressSnapshot = Readonly<{
  planVersion: number;
  satisfiedCriteria: readonly string[];
  remainingCriteria: readonly string[];
  nextActions: readonly GovernorAgentLoopProgressAction[];
  fingerprint: string;
  semanticFingerprint: string;
}>;

function actionPurpose(
  config: GovernorAgentLoopConfiguration,
  criterionId: string | undefined,
): string {
  return (
    config.criteria.find((criterion) => criterion.criterionId === criterionId)?.description ??
    "Host-authorized action"
  );
}

export function buildGovernorAgentLoopProgress(
  controller: GovernorController,
  taskId: GovernorTaskId,
  config: GovernorAgentLoopConfiguration,
): GovernorAgentLoopProgressSnapshot {
  const task = controller.store.loadTask(taskId);
  if (!task) {
    throw new Error("GOVERNOR_AGENT_LOOP_TASK_UNAVAILABLE");
  }
  const satisfied = new Set(
    controller.store
      .listEvidence(taskId)
      .filter((item) => item.admissibility === "admitted" && item.invalidatedAt === undefined)
      .map((item) => item.criterionId),
  );
  const criteria = task.contract.completionCriteria.filter((criterion) => criterion.mandatory);
  const satisfiedCriteria = criteria
    .filter((criterion) => satisfied.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId);
  const remainingCriteria = criteria
    .filter((criterion) => !satisfied.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId);
  const nextActions: GovernorAgentLoopProgressAction[] = [];

  for (const binding of config.toolBindings) {
    if (binding.criterionId) {
      if (!satisfied.has(binding.criterionId)) {
        nextActions.push({
          toolName: binding.toolName,
          criterionId: binding.criterionId,
          purpose: actionPurpose(config, binding.criterionId),
          arguments: {},
        });
      }
      continue;
    }
    if (binding.criteriaByValue && binding.criterionArgument) {
      for (const [value, criterionId] of Object.entries(binding.criteriaByValue)) {
        if (!satisfied.has(criterionId)) {
          nextActions.push({
            toolName: binding.toolName,
            criterionId,
            purpose: actionPurpose(config, criterionId),
            arguments: { [binding.criterionArgument]: value },
          });
        }
      }
      continue;
    }
    nextActions.push({
      toolName: binding.toolName,
      purpose: actionPurpose(config, undefined),
      arguments: {},
    });
  }

  const semanticFingerprint = governorDigest({
    satisfiedCriteria,
    remainingCriteria,
    nextActions,
  });
  const evidenceFingerprint = governorDigest(
    controller.store.listEvidence(taskId).map((item) => ({
      evidenceId: item.evidenceId,
      evidenceDigest: item.evidenceDigest,
      invalidatedAt: item.invalidatedAt ?? null,
      taskVersion: item.taskVersion,
      planVersion: item.planVersion,
    })),
  );
  const fingerprint = governorDigest({
    planVersion: task.planVersion,
    semanticFingerprint,
    evidenceFingerprint,
  });
  return Object.freeze({
    planVersion: task.planVersion,
    satisfiedCriteria: Object.freeze(satisfiedCriteria),
    remainingCriteria: Object.freeze(remainingCriteria),
    nextActions: Object.freeze(nextActions.map((action) => Object.freeze(action))),
    fingerprint,
    semanticFingerprint,
  });
}

export function formatGovernorAgentLoopProgress(
  snapshot: GovernorAgentLoopProgressSnapshot,
): string {
  const satisfied = snapshot.satisfiedCriteria.join(", ") || "none";
  const remaining = snapshot.remainingCriteria.join(", ") || "none";
  const next = snapshot.nextActions.length
    ? snapshot.nextActions
        .map(
          (action) =>
            `${action.toolName}(${JSON.stringify(action.arguments)}) -> ${action.criterionId ?? "auxiliary"}`,
        )
        .join("; ")
    : "none";
  return `Host progress (verified): revision=${snapshot.fingerprint}; plan=${snapshot.planVersion}; satisfied=[${satisfied}]; remaining=[${remaining}]; eligible-next=[${next}]. Use an eligible next action and do not repeat a satisfied criterion.`;
}

export function formatGovernorAlreadySatisfiedReason(
  snapshot: GovernorAgentLoopProgressSnapshot,
  criterionId: string,
): string {
  const next = snapshot.nextActions
    .map((action) => action.toolName)
    .filter((toolName, index, names) => names.indexOf(toolName) === index)
    .join(", ");
  return `GOVERNOR_CRITERION_ALREADY_SATISFIED:${criterionId};NEXT:${next || "none"}`;
}

export function governorAgentLoopSafetyBudget(config: GovernorAgentLoopConfiguration): number {
  const complexity = Math.max(1, config.criteria.length);
  const derived = 4 + complexity * 3 + config.toolBindings.length * 2;
  return Math.max(1, Math.min(config.maxTurns, derived));
}
