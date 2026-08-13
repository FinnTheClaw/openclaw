/** Tiny inert registry exposed to the embedded agent loop. */
import {
  isGovernorAgentLoopRunScope as isRegisteredGovernorAgentLoopRunScope,
  resolveGovernorAgentLoopRunScope as resolveRegisteredScope,
  resolveGovernorCompletedIngressReplay as resolveRegisteredReplay,
} from "./governor-agent-loop-inert-registry.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
  GovernorAgentLoopToolDecision,
  GovernorAgentLoopToolTicket,
  GovernorAgentLoopTurnDecision,
} from "./governor-agent-loop-types.js";

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
  return resolveRegisteredScope(input);
}

/** Performs only the authenticated, read-only completed-ingress lookup. */
export function resolveGovernorCompletedIngressReplay(
  input: GovernorAgentLoopRunInput,
): string | undefined {
  return resolveRegisteredReplay(input);
}

export function isGovernorAgentLoopRunScope(scope: GovernorAgentLoopRunScope): boolean {
  return isRegisteredGovernorAgentLoopRunScope(scope);
}
