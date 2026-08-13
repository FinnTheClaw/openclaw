import {
  isSelectedGovernorAgentLoopScope,
  resolveCompletedGovernorIngressTask,
  type GovernorAgentLoopReplayHost,
} from "./governor-agent-loop-replay-lookup.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";

export function resolveHostGovernorCompletedIngressReplay(params: {
  host: GovernorAgentLoopReplayHost | undefined;
  input: GovernorAgentLoopRunInput;
}): string | undefined {
  const { host, input } = params;
  if (!host || host.config.mode === "shadow" || !isSelectedGovernorAgentLoopScope(host, input)) {
    return undefined;
  }
  return resolveCompletedGovernorIngressTask(host, input);
}
