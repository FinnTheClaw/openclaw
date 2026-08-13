import { clearGovernorAgentLoopInertRegistry } from "./governor-agent-loop-inert-registry.js";
import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";

/** Drains only one lifecycle-owned host and preserves every cleanup error. */
export function closeGovernorAgentLoopHost(params: {
  host: { scopes: Set<GovernorAgentLoopRunScope> };
  registryToken: object;
  isActive: () => boolean;
  clearActive: () => void;
}): void {
  const errors: unknown[] = [];
  if (params.isActive()) {
    params.clearActive();
  }
  clearGovernorAgentLoopInertRegistry(params.registryToken);
  for (const scope of params.host.scopes) {
    try {
      scope.interrupt({ now: Date.now() });
    } catch (error) {
      errors.push(error);
    }
    try {
      scope.dispose();
    } catch (error) {
      errors.push(error);
    } finally {
      params.host.scopes.delete(scope);
    }
  }
  params.host.scopes.clear();
  if (errors.length > 0) {
    throw new AggregateError(errors, "GOVERNOR_AGENT_LOOP_HOST_CLOSE_FAILED");
  }
}
