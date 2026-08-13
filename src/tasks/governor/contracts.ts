import { assertGovernorJsonResources } from "./resource-guard.js";
// Validates governor task contracts and executable ordered/DAG plans.
import type { GovernorPlan, GovernorTaskContract } from "./types.js";

function assertUniqueNonEmpty(values: readonly string[], _label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error("GOVERNOR_CONTRACT_EMPTY_VALUE");
    }
    if (seen.has(normalized)) {
      throw new Error("GOVERNOR_CONTRACT_DUPLICATE_VALUE");
    }
    seen.add(normalized);
  }
}

export function assertValidGovernorContract(contract: GovernorTaskContract): void {
  assertGovernorJsonResources(contract);
  if (!contract.objective.trim()) {
    throw new Error("task objective must not be empty");
  }
  const criterionIds = contract.completionCriteria.map((criterion) => criterion.criterionId);
  assertUniqueNonEmpty(criterionIds, "completion criteria");
  const knownCriteria = new Set(criterionIds);
  const dependencies = new Map<string, readonly string[]>();
  for (const criterion of contract.completionCriteria) {
    if (!criterion.description.trim()) {
      throw new Error("GOVERNOR_CRITERION_DESCRIPTION_REQUIRED");
    }
    const criterionDependencies = criterion.dependsOnCriteria ?? [];
    assertUniqueNonEmpty(criterionDependencies, `dependencies for ${criterion.criterionId}`);
    for (const dependency of criterionDependencies) {
      if (!knownCriteria.has(dependency) || dependency === criterion.criterionId) {
        throw new Error("GOVERNOR_CONTRACT_DEPENDENCY_UNKNOWN");
      }
    }
    dependencies.set(criterion.criterionId, criterionDependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (criterionId: string): void => {
    if (visited.has(criterionId)) {
      return;
    }
    if (visiting.has(criterionId)) {
      throw new Error("GOVERNOR_CONTRACT_DEPENDENCY_CYCLE");
    }
    visiting.add(criterionId);
    for (const dependency of dependencies.get(criterionId) ?? []) {
      visit(dependency);
    }
    visiting.delete(criterionId);
    visited.add(criterionId);
  };
  for (const criterionId of criterionIds) {
    visit(criterionId);
  }
  assertUniqueNonEmpty(contract.authority.mutationCapabilities, "mutation capabilities");
  assertUniqueNonEmpty(contract.authority.canonicalTargets, "canonical targets");
}

function visitPlanStep(
  stepId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
  visiting: Set<string>,
  visited: Set<string>,
): void {
  if (visited.has(stepId)) {
    return;
  }
  if (visiting.has(stepId)) {
    throw new Error("GOVERNOR_PLAN_DEPENDENCY_CYCLE");
  }
  visiting.add(stepId);
  for (const dependency of dependencies.get(stepId) ?? []) {
    visitPlanStep(dependency, dependencies, visiting, visited);
  }
  visiting.delete(stepId);
  visited.add(stepId);
}

export function assertValidGovernorPlan(plan: GovernorPlan, contract: GovernorTaskContract): void {
  assertGovernorJsonResources(plan);
  assertGovernorJsonResources(contract);
  const stepIds = plan.steps.map((step) => step.stepId);
  assertUniqueNonEmpty(stepIds, "plan steps");
  const knownSteps = new Set(stepIds);
  const knownCriteria = new Set(
    contract.completionCriteria.map((criterion) => criterion.criterionId),
  );
  const dependencies = new Map<string, readonly string[]>();
  for (const step of plan.steps) {
    if (!step.description.trim()) {
      throw new Error("GOVERNOR_PLAN_STEP_DESCRIPTION_REQUIRED");
    }
    assertUniqueNonEmpty(step.dependsOn, `dependencies for ${step.stepId}`);
    assertUniqueNonEmpty(step.criterionIds, `criteria for ${step.stepId}`);
    for (const dependency of step.dependsOn) {
      if (!knownSteps.has(dependency)) {
        throw new Error("GOVERNOR_PLAN_DEPENDENCY_UNKNOWN");
      }
    }
    for (const criterionId of step.criterionIds) {
      if (!knownCriteria.has(criterionId)) {
        throw new Error("GOVERNOR_PLAN_CRITERION_UNKNOWN");
      }
    }
    dependencies.set(step.stepId, step.dependsOn);
  }
  const visited = new Set<string>();
  for (const stepId of stepIds) {
    visitPlanStep(stepId, dependencies, new Set(), visited);
  }
  if (plan.kind === "ordered") {
    for (const [index, step] of plan.steps.entries()) {
      const laterSteps = new Set(stepIds.slice(index + 1));
      const invalidDependency = step.dependsOn.find((dependency) => laterSteps.has(dependency));
      if (invalidDependency) {
        throw new Error("GOVERNOR_ORDERED_PLAN_DEPENDENCY_INVALID");
      }
    }
  }
}
