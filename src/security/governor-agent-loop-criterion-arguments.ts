import type { GovernorAgentLoopToolBinding } from "./governor-agent-loop-config.js";
import {
  governorAgentLoopTopLevelString,
  safeGovernorAgentLoopValue,
} from "./governor-agent-loop-values.js";

export function validateGovernorCriterionArguments(params: {
  binding: GovernorAgentLoopToolBinding;
  args: unknown;
}): string | undefined {
  const { binding, args } = params;
  if (!binding.criteriaByValue || !binding.criterionArgument) {
    return undefined;
  }
  const allowed = Object.keys(binding.criteriaByValue);
  const value = governorAgentLoopTopLevelString(
    safeGovernorAgentLoopValue(args),
    binding.criterionArgument,
  );
  if (!value) {
    return `GOVERNOR_TOOL_ARGUMENT_REQUIRED:${binding.criterionArgument};ALLOWED:${allowed.join(",")}`;
  }
  if (!(value in binding.criteriaByValue)) {
    return `GOVERNOR_TOOL_ARGUMENT_INVALID:${binding.criterionArgument};ALLOWED:${allowed.join(",")}`;
  }
  return undefined;
}
