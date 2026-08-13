import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { createGovernorAgentLoopTool } from "./governor-agent-loop-tools.js";

export function createGovernorAgentLoopTools(config: GovernorAgentLoopConfiguration) {
  return Object.freeze(
    config.toolBindings.map((binding) => {
      const criterionId =
        binding.criterionId ??
        (binding.criteriaByValue ? Object.values(binding.criteriaByValue)[0] : undefined);
      return createGovernorAgentLoopTool({
        toolName: binding.toolName,
        implementationId: binding.implementationId,
        purpose:
          config.criteria.find((criterion) => criterion.criterionId === criterionId)?.description ??
          "Host-authorized action",
        ...(binding.criterionArgument ? { argumentName: binding.criterionArgument } : {}),
        ...(binding.criteriaByValue
          ? { allowedArgumentValues: Object.keys(binding.criteriaByValue) }
          : {}),
      });
    }),
  );
}
