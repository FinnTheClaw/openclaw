import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";

type Callbacks = Readonly<{
  resolveScope: (input: GovernorAgentLoopRunInput) => GovernorAgentLoopRunScope | undefined;
  resolveCompletedReplay: (input: GovernorAgentLoopRunInput) => string | undefined;
  isScope: (scope: GovernorAgentLoopRunScope) => boolean;
}>;

let active: { token: object; callbacks: Callbacks } | undefined;

export function installGovernorAgentLoopInertRegistry(callbacks: Callbacks): object {
  if (active) {
    throw new Error("GOVERNOR_AGENT_LOOP_REGISTRY_ALREADY_ACTIVE");
  }
  const token = {};
  active = { token, callbacks };
  return token;
}

export function clearGovernorAgentLoopInertRegistry(token: object): void {
  if (active?.token === token) {
    active = undefined;
  }
}

export function resolveGovernorAgentLoopRunScope(
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope | undefined {
  return active?.callbacks.resolveScope(input);
}

export function resolveGovernorCompletedIngressReplay(
  input: GovernorAgentLoopRunInput,
): string | undefined {
  return active?.callbacks.resolveCompletedReplay(input);
}

export function isGovernorAgentLoopRunScope(scope: GovernorAgentLoopRunScope): boolean {
  return active?.callbacks.isScope(scope) === true;
}
