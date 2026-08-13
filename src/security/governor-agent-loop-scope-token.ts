import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";

const RUN_SCOPES = new WeakSet<object>();

export function markGovernorAgentLoopScope(scope: GovernorAgentLoopRunScope): void {
  RUN_SCOPES.add(scope);
}

export function isHostIssuedGovernorAgentLoopScope(scope: GovernorAgentLoopRunScope): boolean {
  return RUN_SCOPES.has(scope);
}
