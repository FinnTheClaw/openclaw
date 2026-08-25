import type { GovernorPlan, GovernorTaskProjection } from "../tasks/governor/types.js";

/** Builds the host-owned plan from the durable contract, including its DAG edges. */
export function buildGovernorAgentLoopPlan(task: GovernorTaskProjection): GovernorPlan {
  const criterionStep = new Map(
    task.contract.completionCriteria.map((criterion, index) => [
      criterion.criterionId,
      `runtime-step-${index + 1}`,
    ]),
  );
  const hasDependencies = task.contract.completionCriteria.some(
    (criterion) => (criterion.dependsOnCriteria?.length ?? 0) > 0,
  );
  return {
    kind: hasDependencies ? "dag" : "ordered",
    steps: task.contract.completionCriteria.map((criterion, index) => ({
      stepId: `runtime-step-${index + 1}`,
      description: `Satisfy ${criterion.criterionId}`,
      criterionIds: [criterion.criterionId],
      dependsOn: criterion.dependsOnCriteria?.length
        ? criterion.dependsOnCriteria.map((id) => criterionStep.get(id)!).toSorted()
        : hasDependencies
          ? []
          : index === 0
            ? []
            : [`runtime-step-${index}`],
    })),
  };
}
