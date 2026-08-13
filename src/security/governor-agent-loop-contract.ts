import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";

export function createGovernorAgentLoopContract(params: {
  promptDigest: string;
  config: GovernorAgentLoopConfiguration;
  definitions: readonly (GovernorCapabilityDefinition | undefined)[];
}) {
  const { config, definitions } = params;
  return {
    objective: `Complete host-governed agent request ${params.promptDigest.slice(0, 16)}`,
    constraints: [
      "Use only host-authorized capabilities",
      "Completion requires current admitted evidence",
    ],
    knownFacts: [],
    unknowns: config.criteria.map((item) => item.criterionId),
    completionCriteria: config.criteria.map((item) => ({ ...item, mandatory: true })),
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: definitions
        .filter((item) => item?.mutating)
        .map((item) => item!.capability),
      canonicalTargets: config.toolBindings
        .filter((_, index) => definitions[index]?.mutating)
        .map((item) => item.canonicalTarget),
    },
  };
}
