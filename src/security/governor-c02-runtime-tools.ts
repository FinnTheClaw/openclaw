import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import { dataRecord, fail } from "./governor-c02-runtime-attestation-model.js";
import {
  C02_MAX_TURNS,
  governorC02RunBindingDigest,
  prepareGovernorC02Run,
} from "./governor-c02-simple-efficiency-policy.js";
import {
  createGovernorInstalledToolAttestor,
  governorInstalledToolDefinitionDigest,
} from "./governor-installed-tool-attestor.js";

export function governorC02CriterionValue(args: unknown, key: string): string | undefined {
  const value = dataRecord(args)?.[key];
  return typeof value === "string" ? value : undefined;
}

export function failGovernorC02Construction(params: {
  scope: GovernorAgentLoopRunScope;
  attestor?: Readonly<{ close(): void }>;
  error: unknown;
}): never {
  params.attestor?.close();
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    params.scope.dispose();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (cleanupFailed) {
    throw new AggregateError(
      [params.error, cleanupError],
      "GOVERNOR_C02_ATTESTATION_CONSTRUCTION_CLEANUP_FAILED",
      { cause: cleanupError },
    );
  }
  throw params.error;
}

export function prepareGovernorC02InstalledTools(params: {
  scope: GovernorAgentLoopRunScope;
  installedTools: readonly AgentTool[];
  config: GovernorAgentLoopConfiguration;
  capabilities: readonly GovernorCapabilityDefinition[];
  run: GovernorAgentLoopRunInput;
  hostDescriptorDigest: string;
}) {
  params.scope.prepareTools?.(params.installedTools);
  const policyTools = params.scope.governedTools();
  const governed = (["read", "exec"] as const).map((toolName) => {
    const matches = params.installedTools.filter((tool) => tool.name === toolName);
    if (matches.length !== 1) {
      fail();
    }
    return matches[0]!;
  });
  if (
    new Set(params.installedTools).size !== params.installedTools.length ||
    policyTools.length !== 2 ||
    policyTools[0] !== governed[0] ||
    policyTools[1] !== governed[1]
  ) {
    fail();
  }
  const attestor = createGovernorInstalledToolAttestor();
  const handles = governed.map((tool) => {
    const binding = params.config.toolBindings.find((item) => item.toolName === tool.name);
    const capability = params.capabilities.find((item) => item.capability === binding?.capability);
    if (!binding || !capability) {
      fail();
    }
    return attestor.attest({
      tool,
      expected: {
        toolName: tool.name,
        implementationId: binding.implementationId,
        toolDefinitionDigest: governorInstalledToolDefinitionDigest(tool),
        canonicalTargetPrefixes: [...capability.canonicalTargetPrefixes].toSorted(),
      },
    });
  });
  const identities = handles.map((handle) => attestor.registeredTool(handle));
  const read = params.config.toolBindings[0];
  const aggregate = params.config.toolBindings[1];
  const readValues = read?.criteriaByValue ? Object.entries(read.criteriaByValue) : [];
  const aggregateValues = aggregate?.criteriaByValue
    ? Object.entries(aggregate.criteriaByValue)
    : [];
  if (
    params.config.maxTurns !== C02_MAX_TURNS ||
    params.config.expectedAssistantTextDigest !== undefined ||
    read?.toolName !== "read" ||
    read.criterionArgument !== "path" ||
    aggregate?.toolName !== "exec" ||
    aggregate.criterionArgument !== "command" ||
    readValues.length !== 2 ||
    aggregateValues.length !== 1
  ) {
    fail();
  }
  const bindings = [
    ...readValues.map(([value, criterionId]) => ({ tool: read, value, criterionId })),
    ...aggregateValues.map(([value, criterionId]) => ({ tool: aggregate, value, criterionId })),
  ].map(({ tool, value, criterionId }) => {
    const identity = identities.find((item) => item.toolName === tool.toolName)!;
    return {
      toolName: tool.toolName as "read" | "exec",
      criterionId: criterionId as "c02-observe-a" | "c02-observe-b" | "c02-aggregate",
      criterionArgument: tool.criterionArgument as "path" | "command",
      criterionValue: value,
      canonicalTarget: tool.canonicalTarget,
      implementationId: identity.implementationId,
      toolDefinitionDigest: identity.toolDefinitionDigest,
    };
  });
  const material = {
    requestId: params.run.runId,
    sessionKey: params.run.sessionKey,
    hostDescriptorDigest: params.hostDescriptorDigest,
    hostToolRegistryDigest: attestor.digest(handles),
    registeredTools: identities as never,
    bindings: bindings as never,
  };
  return Object.freeze({
    attestor,
    handles: Object.freeze(handles),
    governed: Object.freeze(governed),
    prepared: prepareGovernorC02Run({
      ...material,
      runBindingDigest: governorC02RunBindingDigest(material),
    }),
  });
}
