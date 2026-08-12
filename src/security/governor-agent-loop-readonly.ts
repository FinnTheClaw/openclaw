/** Read-only object-capability exposed to the embedded agent loop. */
import {
  isHostIssuedGovernorAgentLoopScope,
  resolveHostGovernorAgentLoopScope,
  type GovernorAgentLoopRunInput,
  type GovernorAgentLoopRunScope,
  type GovernorAgentLoopToolDecision,
  type GovernorAgentLoopToolTicket,
  type GovernorAgentLoopTurnDecision,
} from "./governor-agent-loop-host.js";

export type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
  GovernorAgentLoopToolDecision,
  GovernorAgentLoopToolTicket,
  GovernorAgentLoopTurnDecision,
};

/** Returns only a host-issued, read-only run capability; OFF has no active host. */
export function resolveGovernorAgentLoopRunScope(
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope | undefined {
  return resolveHostGovernorAgentLoopScope(input);
}

export function isGovernorAgentLoopRunScope(scope: GovernorAgentLoopRunScope): boolean {
  return isHostIssuedGovernorAgentLoopScope(scope);
}
