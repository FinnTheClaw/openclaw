import { governorDigest } from "../tasks/governor/canonical-json.js";

export const C02_SIMPLE_EFFICIENCY_ID = "c02-simple-efficiency";
export const C02_SIMPLE_EFFICIENCY_VERSION = "v1";
export const C02_TRAJECTORY_SCHEMA = "openclaw.behavior-governor-trajectory/v1";
export const C02_MAX_TURNS = 8;
export const C02_COMPLETION_VERIFICATION = "none" as const;

export const C02_CRITERIA_TEMPLATE = Object.freeze([
  Object.freeze({ criterionId: "c02-observe-a", action: "observe", dependsOn: Object.freeze([]) }),
  Object.freeze({ criterionId: "c02-observe-b", action: "observe", dependsOn: Object.freeze([]) }),
  Object.freeze({
    criterionId: "c02-aggregate",
    action: "aggregate",
    dependsOn: Object.freeze(["c02-observe-a", "c02-observe-b"]),
  }),
] as const);

export const C02_FEATURE_PROFILE = Object.freeze({
  redundant_action_suppression: true,
  eligible_next_steering: true,
  request_bound_trajectory: true,
  action_sequence: Object.freeze(["observe", "observe", "aggregate"] as const),
});

export type GovernorC02Criterion = Readonly<{
  criterionId: string;
  action: "observe" | "aggregate";
  dependsOn: readonly string[];
  satisfied: boolean;
}>;

export type GovernorC02RunBinding = Readonly<{
  toolName: "read" | "exec";
  criterionId: "c02-observe-a" | "c02-observe-b" | "c02-aggregate";
  criterionArgument: "path" | "command";
  criterionValue: string;
  canonicalTarget: string;
  implementationId: string;
  toolDefinitionDigest: string;
}>;

export type GovernorC02RegisteredTool = Readonly<{
  toolName: "read" | "exec";
  implementationId: string;
  toolDefinitionDigest: string;
  canonicalTargetPrefixes: readonly string[];
}>;

export type GovernorC02RunPreparation = Readonly<{
  requestId: string;
  sessionKey: string;
  hostDescriptorDigest: string;
  hostToolRegistryDigest: string;
  runBindingDigest: string;
  registeredTools: readonly GovernorC02RegisteredTool[];
  bindings: readonly GovernorC02RunBinding[];
}>;

export type GovernorC02PreparedRun = GovernorC02RunPreparation &
  Readonly<{ toolRegistryDigest: string }>;

export type GovernorC02RunBindingMaterial = Omit<GovernorC02RunPreparation, "runBindingDigest">;

const preparedRuns = new WeakSet<object>();

export type GovernorC02PolicyInput = Readonly<{
  run: GovernorC02PreparedRun;
  projectionRequestId: string;
  projectionRunBindingDigest: string;
  criteria: readonly GovernorC02Criterion[];
  attemptedCriterionId?: string;
}>;

export type GovernorC02PolicyDecision = Readonly<{
  requestId: string;
  eligibleCriterionIds: readonly string[];
  attempted:
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "allow"; criterionId: string }>
    | Readonly<{
        kind: "block";
        criterionId: string;
        reasonCode: "C02_REDUNDANT_ACTION" | "C02_ACTION_NOT_ELIGIBLE";
      }>;
}>;

function validate(input: GovernorC02PolicyInput): ReadonlyMap<string, GovernorC02Criterion> {
  if (
    input.projectionRequestId !== input.run.requestId ||
    input.projectionRunBindingDigest !== input.run.runBindingDigest
  ) {
    throw new Error("GOVERNOR_C02_PROJECTION_BINDING_MISMATCH");
  }
  const byId = new Map<string, GovernorC02Criterion>();
  for (const criterion of input.criteria) {
    if (
      !validText(criterion.criterionId, 256) ||
      typeof criterion.satisfied !== "boolean" ||
      byId.has(criterion.criterionId)
    ) {
      throw new Error("GOVERNOR_C02_CRITERION_GRAPH_INVALID");
    }
    byId.set(criterion.criterionId, criterion);
  }
  for (const criterion of input.criteria) {
    if (
      new Set(criterion.dependsOn).size !== criterion.dependsOn.length ||
      criterion.dependsOn.some(
        (dependency) => !byId.has(dependency) || dependency === criterion.criterionId,
      )
    ) {
      throw new Error("GOVERNOR_C02_CRITERION_GRAPH_INVALID");
    }
  }
  if (
    input.criteria.length !== C02_CRITERIA_TEMPLATE.length ||
    input.criteria.some((criterion, index) => {
      const expected = C02_CRITERIA_TEMPLATE[index];
      return (
        !expected ||
        criterion.criterionId !== expected.criterionId ||
        criterion.action !== expected.action ||
        criterion.dependsOn.length !== expected.dependsOn.length ||
        criterion.dependsOn.some(
          (dependency, dependencyIndex) => dependency !== expected.dependsOn[dependencyIndex],
        )
      );
    })
  ) {
    throw new Error("GOVERNOR_C02_CRITERION_TEMPLATE_MISMATCH");
  }
  return byId;
}

function validText(value: string, max: number): boolean {
  return (
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  );
}

export function prepareGovernorC02Run(input: GovernorC02RunPreparation): GovernorC02PreparedRun {
  if (
    !validText(input.requestId, 256) ||
    !validText(input.sessionKey, 256) ||
    !/^[a-f0-9]{64}$/u.test(input.hostDescriptorDigest) ||
    !/^[a-f0-9]{64}$/u.test(input.hostToolRegistryDigest) ||
    !/^[a-f0-9]{64}$/u.test(input.runBindingDigest)
  ) {
    throw new Error("GOVERNOR_C02_RUN_BINDING_REQUIRED");
  }
  const expected = new Map<GovernorC02RunBinding["criterionId"], readonly [string, string]>([
    ["c02-observe-a", ["read", "path"]],
    ["c02-observe-b", ["read", "path"]],
    ["c02-aggregate", ["exec", "command"]],
  ]);
  if (input.bindings.length !== expected.size) {
    throw new Error("GOVERNOR_C02_RUN_BINDINGS_INVALID");
  }
  const seenCriteria = new Set<string>();
  const seenMatches = new Set<string>();
  if (
    input.registeredTools.length !== 2 ||
    input.registeredTools[0]?.toolName !== "read" ||
    input.registeredTools[1]?.toolName !== "exec"
  ) {
    throw new Error("GOVERNOR_C02_TOOL_REGISTRY_INVALID");
  }
  const registeredTools = new Map<string, GovernorC02RegisteredTool>();
  for (const tool of input.registeredTools) {
    if (
      !validText(tool.implementationId, 256) ||
      !/^[a-f0-9]{64}$/u.test(tool.toolDefinitionDigest) ||
      tool.canonicalTargetPrefixes.length === 0 ||
      tool.canonicalTargetPrefixes.some((prefix) => !validText(prefix, 2048)) ||
      registeredTools.has(tool.toolName)
    ) {
      throw new Error("GOVERNOR_C02_TOOL_REGISTRY_INVALID");
    }
    registeredTools.set(tool.toolName, tool);
  }
  const expectedOrder = ["c02-observe-a", "c02-observe-b", "c02-aggregate"] as const;
  for (const [index, binding] of input.bindings.entries()) {
    const identity = expected.get(binding.criterionId);
    const registered = registeredTools.get(binding.toolName);
    const match = `${binding.toolName}\0${binding.criterionArgument}\0${binding.criterionValue}`;
    if (
      !identity ||
      binding.criterionId !== expectedOrder[index] ||
      binding.toolName !== identity[0] ||
      binding.criterionArgument !== identity[1] ||
      !validText(binding.criterionValue, 8192) ||
      !validText(binding.canonicalTarget, 2048) ||
      !validText(binding.implementationId, 256) ||
      !/^[a-f0-9]{64}$/u.test(binding.toolDefinitionDigest) ||
      !registered ||
      binding.implementationId !== registered.implementationId ||
      binding.toolDefinitionDigest !== registered.toolDefinitionDigest ||
      !registered.canonicalTargetPrefixes.some((prefix) =>
        binding.canonicalTarget.startsWith(prefix),
      ) ||
      seenCriteria.has(binding.criterionId) ||
      seenMatches.has(match)
    ) {
      throw new Error("GOVERNOR_C02_RUN_BINDINGS_INVALID");
    }
    seenCriteria.add(binding.criterionId);
    seenMatches.add(match);
  }
  const registeredToolSnapshot = input.registeredTools.map((tool) => ({
    ...tool,
    canonicalTargetPrefixes: [...tool.canonicalTargetPrefixes],
  }));
  const bindingSnapshot = input.bindings.map((binding) => ({ ...binding }));
  const toolRegistryDigest = governorC02ToolRegistryDigest(registeredToolSnapshot);
  if (toolRegistryDigest !== input.hostToolRegistryDigest) {
    throw new Error("GOVERNOR_C02_TOOL_REGISTRY_DIGEST_MISMATCH");
  }
  const computedRunBindingDigest = governorC02RunBindingDigest({
    ...input,
    registeredTools: registeredToolSnapshot,
    bindings: bindingSnapshot,
  });
  if (computedRunBindingDigest !== input.runBindingDigest) {
    throw new Error("GOVERNOR_C02_RUN_BINDING_DIGEST_MISMATCH");
  }
  const prepared = deepFreeze({
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    hostDescriptorDigest: input.hostDescriptorDigest,
    hostToolRegistryDigest: input.hostToolRegistryDigest,
    runBindingDigest: input.runBindingDigest,
    toolRegistryDigest,
    registeredTools: registeredToolSnapshot,
    bindings: bindingSnapshot,
  });
  preparedRuns.add(prepared);
  return prepared;
}

export function governorC02RunBindingDigest(input: GovernorC02RunBindingMaterial): string {
  const toolRegistryDigest = governorC02ToolRegistryDigest(input.registeredTools);
  return governorDigest({
    schema: C02_TRAJECTORY_SCHEMA,
    moduleId: C02_SIMPLE_EFFICIENCY_ID,
    moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    hostDescriptorDigest: input.hostDescriptorDigest,
    hostToolRegistryDigest: input.hostToolRegistryDigest,
    toolRegistryDigest,
    bindings: input.bindings.map((binding) => ({ ...binding })),
  });
}

export function governorC02ToolRegistryDigest(
  registeredTools: readonly GovernorC02RegisteredTool[],
): string {
  return governorDigest(
    registeredTools.map((tool) => ({
      ...tool,
      canonicalTargetPrefixes: [...tool.canonicalTargetPrefixes],
    })),
  );
}

/** Internal runtime brand check; clones and stale mutable preparations fail closed. */
export function assertGovernorC02PreparedRun(run: GovernorC02PreparedRun): void {
  if (
    !preparedRuns.has(run) ||
    governorC02ToolRegistryDigest(run.registeredTools) !== run.hostToolRegistryDigest ||
    governorC02RunBindingDigest(run) !== run.runBindingDigest
  ) {
    throw new Error("GOVERNOR_C02_PREPARED_RUN_INVALID");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function evaluateGovernorC02Policy(
  input: GovernorC02PolicyInput,
): GovernorC02PolicyDecision {
  assertGovernorC02PreparedRun(input.run);
  const byId = validate(input);
  const eligibleCriterionIds = Object.freeze(
    input.criteria
      .filter(
        (criterion) =>
          !criterion.satisfied &&
          criterion.dependsOn.every((dependency) => byId.get(dependency)?.satisfied === true),
      )
      .map((criterion) => criterion.criterionId),
  );
  const attemptedCriterionId = input.attemptedCriterionId;
  if (!attemptedCriterionId) {
    return deepFreeze({
      requestId: input.run.requestId,
      eligibleCriterionIds,
      attempted: { kind: "none" as const },
    });
  }
  const attempted = byId.get(attemptedCriterionId);
  if (!attempted) {
    throw new Error("GOVERNOR_C02_CRITERION_UNKNOWN");
  }
  if (attempted.satisfied) {
    return deepFreeze({
      requestId: input.run.requestId,
      eligibleCriterionIds,
      attempted: {
        kind: "block" as const,
        criterionId: attemptedCriterionId,
        reasonCode: "C02_REDUNDANT_ACTION" as const,
      },
    });
  }
  if (!eligibleCriterionIds.includes(attemptedCriterionId)) {
    return deepFreeze({
      requestId: input.run.requestId,
      eligibleCriterionIds,
      attempted: {
        kind: "block" as const,
        criterionId: attemptedCriterionId,
        reasonCode: "C02_ACTION_NOT_ELIGIBLE" as const,
      },
    });
  }
  return deepFreeze({
    requestId: input.run.requestId,
    eligibleCriterionIds,
    attempted: { kind: "allow" as const, criterionId: attemptedCriterionId },
  });
}
