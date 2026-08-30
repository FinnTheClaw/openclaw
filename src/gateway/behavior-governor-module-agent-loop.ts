import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import {
  clearGovernorAgentLoopInertRegistry,
  installGovernorAgentLoopInertRegistry,
} from "../security/governor-agent-loop-inert-registry.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
  GovernorAgentLoopToolDecision,
  GovernorAgentLoopToolTicket,
  GovernorAgentLoopTurnDecision,
} from "../security/governor-agent-loop-types.js";

export type GatewayBehaviorGovernorModuleActivation = Readonly<{
  id: string;
  mode: BehaviorGovernorModuleSelection["mode"];
  version: string;
}>;

export type GatewayBehaviorGovernorModuleRunInput = Readonly<{
  activation: GatewayBehaviorGovernorModuleActivation;
  run: GovernorAgentLoopRunInput;
}>;

export type GatewayBehaviorGovernorModuleAgentLoop = Readonly<{
  resolveRunScope: (
    input: GatewayBehaviorGovernorModuleRunInput,
  ) => GovernorAgentLoopRunScope | undefined;
}>;

export type ActiveGatewayBehaviorGovernorAgentLoopModule = Readonly<{
  activation: GatewayBehaviorGovernorModuleActivation;
  agentLoop: GatewayBehaviorGovernorModuleAgentLoop;
}>;

export type GatewayBehaviorGovernorModuleAgentLoopHandle = Readonly<{
  freeze: () => void;
  close: () => void;
}>;

type ComponentScope = Readonly<{
  activation: GatewayBehaviorGovernorModuleActivation;
  scope: GovernorAgentLoopRunScope;
  tools: readonly AgentTool[];
}>;

const REQUIRED_SCOPE_METHODS = [
  "beforeTool",
  "afterTool",
  "afterTurn",
  "interrupt",
  "assertTerminal",
  "governedTools",
  "dispose",
] as const;

function validateScope(
  scope: GovernorAgentLoopRunScope,
  activation: GatewayBehaviorGovernorModuleActivation,
): readonly AgentTool[] {
  if (!scope || typeof scope !== "object") {
    throw new Error("GOVERNOR_MODULE_AGENT_LOOP_SCOPE_INVALID");
  }
  if (scope.mode !== activation.mode) {
    throw new Error("GOVERNOR_MODULE_AGENT_LOOP_MODE_MISMATCH");
  }
  if (scope.disposition === "completed_replay") {
    throw new Error("GOVERNOR_MODULE_AGENT_LOOP_REPLAY_OWNER_FORBIDDEN");
  }
  if (!scope.taskId.trim()) {
    throw new Error("GOVERNOR_MODULE_AGENT_LOOP_TASK_ID_INVALID");
  }
  for (const method of REQUIRED_SCOPE_METHODS) {
    if (typeof scope[method] !== "function") {
      throw new Error("GOVERNOR_MODULE_AGENT_LOOP_SCOPE_INVALID");
    }
  }
  const tools = scope.governedTools();
  if (!Array.isArray(tools) || tools.some((tool) => !tool || !tool.name?.trim())) {
    throw new Error("GOVERNOR_MODULE_AGENT_LOOP_TOOLS_INVALID");
  }
  return Object.freeze([...tools]);
}

function collectErrors(
  components: readonly ComponentScope[],
  operation: (component: ComponentScope) => void,
): void {
  const errors: unknown[] = [];
  for (const component of components) {
    try {
      operation(component);
    } catch (error) {
      if (component.activation.mode === "enforce") {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "GOVERNOR_MODULE_AGENT_LOOP_HOOK_FAILED");
  }
}

function disposeScopes(scopes: readonly GovernorAgentLoopRunScope[]): unknown[] {
  const errors: unknown[] = [];
  for (const scope of scopes.toReversed()) {
    try {
      scope.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwResolutionFailure(
  cause: unknown,
  scopes: readonly GovernorAgentLoopRunScope[],
): never {
  const cleanupErrors = disposeScopes(scopes);
  if (cleanupErrors.length === 0) {
    throw cause;
  }
  throw new AggregateError(
    [cause, ...cleanupErrors],
    "GOVERNOR_MODULE_AGENT_LOOP_RESOLUTION_CLEANUP_FAILED",
    { cause },
  );
}

function sameTurnDecision(
  left: GovernorAgentLoopTurnDecision,
  right: GovernorAgentLoopTurnDecision,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "continue" || (right.kind === "continue" && left.message === right.message)) &&
    (left.kind !== "stop" || (right.kind === "stop" && left.reasonCode === right.reasonCode)) &&
    (left.kind !== "interrupt" ||
      (right.kind === "interrupt" && left.reasonCode === right.reasonCode))
  );
}

function createCompositeScope(
  input: GovernorAgentLoopRunInput,
  components: readonly ComponentScope[],
  issuedScopes: WeakSet<GovernorAgentLoopRunScope>,
): GovernorAgentLoopRunScope {
  const enforce = components.filter((component) => component.activation.mode === "enforce");
  const ticketState = new WeakMap<
    object,
    ReadonlyMap<GovernorAgentLoopRunScope, GovernorAgentLoopToolTicket | undefined>
  >();
  const tools: AgentTool[] = [];
  const toolNames = new Set<string>();
  for (const component of enforce) {
    for (const tool of component.tools) {
      if (toolNames.has(tool.name)) {
        throw new Error("GOVERNOR_MODULE_AGENT_LOOP_TOOL_CONFLICT");
      }
      toolNames.add(tool.name);
      tools.push(tool);
    }
  }
  const governedTools = Object.freeze(tools);
  let disposed = false;
  const scope: GovernorAgentLoopRunScope = Object.freeze({
    taskId: input.runId,
    mode: enforce.length > 0 ? "enforce" : "shadow",
    disposition: "runnable",
    beforeTool(toolInput): GovernorAgentLoopToolDecision {
      const tickets = new Map<GovernorAgentLoopRunScope, GovernorAgentLoopToolTicket | undefined>();
      let blocked: Extract<GovernorAgentLoopToolDecision, { kind: "block" }> | undefined;
      collectErrors(components, (component) => {
        const decision = component.scope.beforeTool(toolInput);
        tickets.set(component.scope, decision.kind === "allow" ? decision.ticket : undefined);
        if (component.activation.mode === "enforce" && decision.kind === "block") {
          blocked ??= decision;
        }
      });
      if (blocked) {
        return blocked;
      }
      if ([...tickets.values()].every((ticket) => ticket === undefined)) {
        return { kind: "allow" };
      }
      const opaque = {};
      ticketState.set(opaque, tickets);
      return { kind: "allow", ticket: Object.freeze({ opaque }) };
    },
    afterTool(toolInput): void {
      const tickets = toolInput.ticket ? ticketState.get(toolInput.ticket.opaque) : undefined;
      if (toolInput.ticket && !tickets) {
        throw new Error("GOVERNOR_MODULE_AGENT_LOOP_TICKET_INVALID");
      }
      if (toolInput.ticket) {
        ticketState.delete(toolInput.ticket.opaque);
      }
      collectErrors(components, (component) => {
        component.scope.afterTool({
          ...toolInput,
          ticket: tickets?.get(component.scope),
        });
      });
    },
    afterTurn(turnInput): GovernorAgentLoopTurnDecision {
      const decisions: GovernorAgentLoopTurnDecision[] = [];
      collectErrors(components, (component) => {
        const decision = component.scope.afterTurn(turnInput);
        if (component.activation.mode === "enforce" && decision.kind !== "complete") {
          decisions.push(decision);
        }
      });
      const first = decisions[0];
      if (!first) {
        return { kind: "complete" };
      }
      if (decisions.some((decision) => !sameTurnDecision(first, decision))) {
        throw new Error("GOVERNOR_MODULE_AGENT_LOOP_DECISION_CONFLICT");
      }
      return first;
    },
    interrupt(interruption): void {
      collectErrors(enforce, (component) => component.scope.interrupt(interruption));
    },
    assertTerminal(): void {
      collectErrors(enforce, (component) => component.scope.assertTerminal());
    },
    governedTools(): readonly AgentTool[] {
      return governedTools;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      issuedScopes.delete(scope);
      collectErrors(components.toReversed(), (component) => component.scope.dispose());
    },
  });
  issuedScopes.add(scope);
  return scope;
}

export function installGatewayBehaviorGovernorModuleAgentLoop(
  modules: readonly ActiveGatewayBehaviorGovernorAgentLoopModule[],
): GatewayBehaviorGovernorModuleAgentLoopHandle | undefined {
  if (modules.length === 0) {
    return undefined;
  }
  let frozen = false;
  let closed = false;
  const issuedScopes = new WeakSet<GovernorAgentLoopRunScope>();
  const registryToken = installGovernorAgentLoopInertRegistry({
    resolveScope: (input) => {
      if (frozen || closed) {
        return undefined;
      }
      const run = Object.freeze({ ...input });
      const components: ComponentScope[] = [];
      for (const module of modules) {
        let candidate: GovernorAgentLoopRunScope | undefined;
        try {
          candidate = module.agentLoop.resolveRunScope(
            Object.freeze({ activation: module.activation, run }),
          );
          if (candidate) {
            components.push({
              activation: module.activation,
              scope: candidate,
              tools: validateScope(candidate, module.activation),
            });
          }
        } catch (error) {
          const priorScopes = components.map((component) => component.scope);
          const scopes = candidate ? [...priorScopes, candidate] : priorScopes;
          if (module.activation.mode === "enforce") {
            throwResolutionFailure(error, scopes);
          }
          if (candidate) {
            disposeScopes([candidate]);
          }
        }
      }
      if (components.length === 0) {
        return undefined;
      }
      try {
        return createCompositeScope(run, components, issuedScopes);
      } catch (error) {
        throwResolutionFailure(
          error,
          components.map((component) => component.scope),
        );
      }
    },
    resolveCompletedReplay: () => undefined,
    isScope: (scope) => issuedScopes.has(scope),
  });
  return Object.freeze({
    freeze() {
      frozen = true;
    },
    close() {
      if (closed) {
        return;
      }
      frozen = true;
      closed = true;
      clearGovernorAgentLoopInertRegistry(registryToken);
    },
  });
}
