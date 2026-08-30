/** Strict data-only configuration for the host-owned agent-loop bridge. */
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { assertGovernorPersistedBoundarySafe } from "../tasks/governor/secret-filter.js";
import {
  isGovernorAgentLoopToolImplementationId,
  type GovernorAgentLoopToolImplementationId,
} from "./governor-agent-loop-tools.js";

export type GovernorAgentLoopMode = "shadow" | "enforce";

export type GovernorAgentLoopCriterion = Readonly<{
  criterionId: string;
  description: string;
  dependsOnCriteria?: readonly string[];
}>;

export type GovernorAgentLoopToolBinding = Readonly<{
  toolName: string;
  capability: string;
  canonicalTarget: string;
  criterionId?: string;
  auxiliary?: boolean;
  criterionArgument?: string;
  criteriaByValue?: Readonly<Record<string, string>>;
  approvalGrantArgument?: string;
  implementationId: GovernorAgentLoopToolImplementationId;
}>;

export type GovernorAgentLoopConfiguration = Readonly<{
  moduleIdentity?: Readonly<{ id: string; version: string }>;
  hostCapabilities?: Readonly<{
    installedToolInventory: boolean;
    toolTurnProvenance: boolean;
  }>;
  mode: GovernorAgentLoopMode;
  scopes: readonly Readonly<{ sessionKey: string; agentId?: string }>[];
  criteria: readonly GovernorAgentLoopCriterion[];
  toolBindings: readonly GovernorAgentLoopToolBinding[];
  maxTurns: number;
  expectedAssistantTextDigest?: string;
}>;

function assertString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  return value;
}

function assertKeys(value: object, allowed: readonly string[]): void {
  const keys = Object.keys(value).toSorted();
  if (
    keys.join("\0") !==
    [...allowed]
      .filter((key) => key in value)
      .toSorted()
      .join("\0")
  ) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
}

export function validateGovernorAgentLoopConfiguration(
  input: GovernorAgentLoopConfiguration,
  capabilities: readonly GovernorCapabilityDefinition[],
  options: Readonly<{ requireExpectedAssistantTextDigest?: boolean }> = {},
): GovernorAgentLoopConfiguration {
  let safeInput: GovernorAgentLoopConfiguration;
  try {
    safeInput = assertGovernorPersistedBoundarySafe(
      "session",
      input,
    ) as unknown as GovernorAgentLoopConfiguration;
  } catch {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  if (
    !safeInput ||
    !["shadow", "enforce"].includes(safeInput.mode) ||
    !Number.isSafeInteger(safeInput.maxTurns) ||
    safeInput.maxTurns < 1 ||
    safeInput.maxTurns > 256 ||
    !Array.isArray(safeInput.scopes) ||
    safeInput.scopes.length < 1
  ) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  assertKeys(safeInput, [
    "moduleIdentity",
    "hostCapabilities",
    "mode",
    "scopes",
    "criteria",
    "toolBindings",
    "maxTurns",
    "expectedAssistantTextDigest",
  ]);
  const moduleIdentity = safeInput.moduleIdentity;
  if (moduleIdentity) {
    assertKeys(moduleIdentity, ["id", "version"]);
    assertString(moduleIdentity.id);
    assertString(moduleIdentity.version);
  }
  if (!Array.isArray(safeInput.criteria) || !Array.isArray(safeInput.toolBindings)) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  const capabilityIds = new Set(capabilities.map((item) => item.capability));
  const criteria = safeInput.criteria.map((item) => {
    assertKeys(item, ["criterionId", "description", "dependsOnCriteria"]);
    const dependsOnCriteria = item.dependsOnCriteria;
    if (
      dependsOnCriteria !== undefined &&
      (!Array.isArray(dependsOnCriteria) ||
        dependsOnCriteria.length > 256 ||
        new Set(dependsOnCriteria).size !== dependsOnCriteria.length)
    ) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
    }
    if (safeInput.hostCapabilities) {
      assertKeys(safeInput.hostCapabilities, ["installedToolInventory", "toolTurnProvenance"]);
      if (
        typeof safeInput.hostCapabilities.installedToolInventory !== "boolean" ||
        typeof safeInput.hostCapabilities.toolTurnProvenance !== "boolean"
      ) {
        throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
      }
    }
    return Object.freeze({
      criterionId: assertString(item.criterionId),
      description: assertString(item.description),
      ...(dependsOnCriteria
        ? { dependsOnCriteria: Object.freeze(dependsOnCriteria.map(assertString)) }
        : {}),
    });
  });
  const criterionIds = new Set(criteria.map((item) => item.criterionId));
  if (criterionIds.size !== criteria.length) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  const toolBindings = safeInput.toolBindings.map((item) => {
    assertKeys(item, [
      "toolName",
      "capability",
      "canonicalTarget",
      "criterionId",
      "auxiliary",
      "criterionArgument",
      "criteriaByValue",
      "approvalGrantArgument",
      "implementationId",
    ]);
    const toolName = assertString(item.toolName);
    const capability = assertString(item.capability);
    if (!capabilityIds.has(capability)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CAPABILITY_UNKNOWN");
    }
    if (!isGovernorAgentLoopToolImplementationId(item.implementationId)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
    }
    const definition = capabilities.find(
      (capabilityDefinition) => capabilityDefinition.capability === capability,
    );
    if (definition?.mutating || definition?.requiresApproval || toolName === "sessions_spawn") {
      throw new Error("GOVERNOR_AGENT_LOOP_READ_ONLY_CANARY_REQUIRED");
    }
    const criterionId = item.criterionId ? assertString(item.criterionId) : undefined;
    const auxiliary = item.auxiliary === true;
    const hasFixedCriterion = criterionId !== undefined;
    const hasMappedCriterion =
      item.criterionArgument !== undefined || item.criteriaByValue !== undefined;
    if (!auxiliary && hasFixedCriterion === hasMappedCriterion) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_BINDING_AMBIGUOUS");
    }
    if (auxiliary && (hasFixedCriterion || hasMappedCriterion)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_BINDING_AMBIGUOUS");
    }
    if (criterionId && !criterionIds.has(criterionId)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CRITERION_UNKNOWN");
    }
    const canonicalTarget = assertString(item.canonicalTarget);
    if (
      !definition ||
      !definition.canonicalTargetPrefixes.some((prefix) => canonicalTarget.startsWith(prefix))
    ) {
      throw new Error("GOVERNOR_AGENT_LOOP_TARGET_NOT_ALLOWED");
    }
    if (
      item.criteriaByValue &&
      (Object.getPrototypeOf(item.criteriaByValue) !== Object.prototype ||
        Object.keys(item.criteriaByValue).length > 256)
    ) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
    }
    if (Boolean(item.criterionArgument) !== Boolean(item.criteriaByValue)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
    }
    let criteriaByValue: Readonly<Record<string, string>> | undefined;
    if (item.criteriaByValue) {
      const entries = Object.entries(item.criteriaByValue).map(([key, value]) => {
        const mappedCriterionId = assertString(value);
        if (!criterionIds.has(mappedCriterionId)) {
          throw new Error("GOVERNOR_AGENT_LOOP_CRITERION_UNKNOWN");
        }
        return [assertString(key), mappedCriterionId] as const;
      });
      criteriaByValue = Object.freeze(Object.fromEntries(entries));
    }
    return Object.freeze({
      toolName,
      capability,
      canonicalTarget,
      implementationId: item.implementationId,
      ...(auxiliary ? { auxiliary: true } : {}),
      ...(criterionId ? { criterionId } : {}),
      ...(item.criterionArgument
        ? { criterionArgument: assertString(item.criterionArgument) }
        : {}),
      ...(criteriaByValue ? { criteriaByValue } : {}),
      ...(item.approvalGrantArgument
        ? { approvalGrantArgument: assertString(item.approvalGrantArgument) }
        : {}),
    }) satisfies GovernorAgentLoopToolBinding;
  });
  if (new Set(toolBindings.map((item) => item.toolName)).size !== toolBindings.length) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  const boundCriteria = new Set(
    toolBindings.flatMap((binding) =>
      binding.criterionId
        ? [binding.criterionId]
        : binding.criteriaByValue
          ? Object.values(binding.criteriaByValue)
          : [],
    ),
  );
  for (const criterion of criteria) {
    if (!boundCriteria.has(criterion.criterionId)) {
      throw new Error("GOVERNOR_AGENT_LOOP_CRITERION_UNBOUND");
    }
    for (const dependency of criterion.dependsOnCriteria ?? []) {
      if (dependency === criterion.criterionId || !criterionIds.has(dependency)) {
        throw new Error("GOVERNOR_AGENT_LOOP_DEPENDENCY_INVALID");
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (criterionId: string): void => {
    if (visiting.has(criterionId)) {
      throw new Error("GOVERNOR_AGENT_LOOP_DEPENDENCY_CYCLE");
    }
    if (visited.has(criterionId)) {
      return;
    }
    visiting.add(criterionId);
    const criterion = criteria.find((item) => item.criterionId === criterionId);
    for (const dependency of criterion?.dependsOnCriteria ?? []) {
      visit(dependency);
    }
    visiting.delete(criterionId);
    visited.add(criterionId);
  };
  for (const criterion of criteria) {
    visit(criterion.criterionId);
  }
  const scopes = safeInput.scopes.map((scope) => {
    assertKeys(scope, ["sessionKey", "agentId"]);
    return Object.freeze({
      sessionKey: assertString(scope.sessionKey),
      ...(scope.agentId ? { agentId: assertString(scope.agentId) } : {}),
    });
  });
  if (
    (safeInput.mode === "enforce" &&
      options.requireExpectedAssistantTextDigest !== false &&
      safeInput.expectedAssistantTextDigest === undefined) ||
    (safeInput.expectedAssistantTextDigest !== undefined &&
      !/^[a-f0-9]{64}$/u.test(safeInput.expectedAssistantTextDigest))
  ) {
    throw new Error("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
  }
  return Object.freeze({
    ...(moduleIdentity
      ? {
          moduleIdentity: Object.freeze({ id: moduleIdentity.id, version: moduleIdentity.version }),
        }
      : {}),
    ...(safeInput.hostCapabilities
      ? { hostCapabilities: Object.freeze({ ...safeInput.hostCapabilities }) }
      : {}),
    mode: safeInput.mode,
    scopes: Object.freeze(scopes),
    criteria: Object.freeze(criteria),
    toolBindings: Object.freeze(toolBindings),
    maxTurns: safeInput.maxTurns,
    ...(safeInput.expectedAssistantTextDigest
      ? { expectedAssistantTextDigest: safeInput.expectedAssistantTextDigest }
      : {}),
  });
}
