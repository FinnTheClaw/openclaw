import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
import type { GatewayBehaviorGovernorModuleRunInput } from "./behavior-governor-module-agent-loop.js";
import type {
  GatewayBehaviorGovernorModuleActivationContext,
  GatewayBehaviorGovernorModuleRuntime,
} from "./behavior-governor-module-lifecycle.js";

export type GatewayBehaviorGovernorModuleGovernedRunDefinition = Readonly<{
  config: (run: GovernorAgentLoopRunInput) => GovernorAgentLoopConfiguration;
  plan: unknown;
  planDigest: string;
}>;

/**
 * One host-backed run consumer owns transient binding cleanup for every module.
 * Modules provide only their policy plan and run-specific governor configuration.
 */
export function createGatewayBehaviorGovernorModuleGovernedRunConsumer(
  context: GatewayBehaviorGovernorModuleActivationContext,
  definition: GatewayBehaviorGovernorModuleGovernedRunDefinition,
): GatewayBehaviorGovernorModuleRuntime {
  const scopes = new Set<GovernorAgentLoopRunScope>();
  let closed = false;

  return Object.freeze({
    agentLoop: Object.freeze({
      resolveRunScope(input: GatewayBehaviorGovernorModuleRunInput) {
        if (closed) {
          throw new Error("GOVERNOR_MODULE_GOVERNED_RUN_CONSUMER_CLOSED");
        }
        const config = definition.config(input.run);
        if (
          config.mode !== context.mode ||
          !config.moduleIdentity ||
          config.moduleIdentity.id !== context.id ||
          config.moduleIdentity.version !== context.version
        ) {
          throw new Error("GOVERNOR_MODULE_GOVERNED_RUN_CONFIGURATION_MISMATCH");
        }
        const provider = context.host.agentLoop.createScopeProvider(config);
        const binding = provider.createRunBinding({
          run: input.run,
          planDigest: definition.planDigest,
          plan: definition.plan,
        });
        let resolved: GovernorAgentLoopRunScope | undefined;
        try {
          resolved = provider.resolveRunScope(input, binding.proof);
          if (!resolved) {
            binding.close();
            provider.close();
            return undefined;
          }
        } catch (error) {
          binding.close();
          provider.close();
          throw error;
        }
        let disposed = false;
        const scope: GovernorAgentLoopRunScope = Object.freeze({
          ...resolved,
          get disposition() {
            return resolved!.disposition;
          },
          dispose() {
            if (disposed) {
              return;
            }
            disposed = true;
            try {
              resolved!.dispose();
            } finally {
              binding.close();
              provider.close();
              scopes.delete(scope);
            }
          },
        });
        scopes.add(scope);
        return scope;
      },
    }),
    close() {
      if (closed) {
        return;
      }
      const errors: unknown[] = [];
      for (const scope of [...scopes].toReversed()) {
        try {
          scope.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0 || scopes.size > 0) {
        throw new AggregateError(errors, "GOVERNOR_MODULE_GOVERNED_RUN_CONSUMER_CLOSE_FAILED");
      }
      closed = true;
    },
  });
}
