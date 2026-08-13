import { assertGovernorAgentLoopAdmission } from "./governor-agent-loop-admission.js";
import type { GovernorAgentLoopReplayHost } from "./governor-agent-loop-replay-lookup.js";
import { resolveHostGovernorCompletedIngressReplay as resolveReplay } from "./governor-agent-loop-terminal-replay.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";

export function createGovernorAgentLoopHostReplayResolver(
  getHost: () => GovernorAgentLoopReplayHost | undefined,
): (input: GovernorAgentLoopRunInput) => string | undefined {
  return (input) => {
    const host = getHost();
    try {
      if (host && !assertGovernorAgentLoopAdmission(host, host.config.mode)) {
        return undefined;
      }
      return resolveReplay({ host, input });
    } catch (error) {
      if (host?.config.mode === "shadow") {
        return undefined;
      }
      throw error;
    }
  };
}
