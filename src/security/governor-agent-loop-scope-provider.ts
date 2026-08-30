import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import { freezeGovernorAgentLoopHostAdmission } from "./governor-agent-loop-admission.js";
import {
  validateGovernorAgentLoopConfiguration,
  type GovernorAgentLoopConfiguration,
} from "./governor-agent-loop-config.js";
import {
  resolveGovernorAgentLoopScopeForHost,
  type GovernorAgentLoopScopeHost,
} from "./governor-agent-loop-host.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import type { HostGovernorCapabilities } from "./governor-host-contracts.js";

export type GovernorAgentLoopScopeProvider = Readonly<{
  resolveRunScope: (input: GovernorAgentLoopRunInput) => GovernorAgentLoopRunScope | undefined;
  freeze: () => void;
  close: () => void;
}>;

/** Creates a host-owned scope provider without installing the process registry. */
export function createGovernorAgentLoopScopeProvider(params: {
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
  capabilities: readonly GovernorCapabilityDefinition[];
  config: GovernorAgentLoopConfiguration;
}): GovernorAgentLoopScopeProvider {
  const host: GovernorAgentLoopScopeHost = Object.freeze({
    controller: params.controller,
    submitObservedReceipt: params.submitObservedReceipt,
    config: validateGovernorAgentLoopConfiguration(params.config, params.capabilities, {
      requireExpectedAssistantTextDigest: false,
    }),
    scopes: new Set<GovernorAgentLoopRunScope>(),
  });
  let closed = false;
  return Object.freeze({
    resolveRunScope(input) {
      if (closed) {
        return undefined;
      }
      return resolveGovernorAgentLoopScopeForHost(host, input);
    },
    freeze() {
      freezeGovernorAgentLoopHostAdmission(host);
    },
    close() {
      if (closed) {
        return;
      }
      freezeGovernorAgentLoopHostAdmission(host);
      const errors: unknown[] = [];
      for (const scope of host.scopes) {
        let disposeFailed = false;
        try {
          scope.interrupt({ now: Date.now() });
        } catch (error) {
          errors.push(error);
        }
        try {
          scope.dispose();
        } catch (error) {
          errors.push(error);
          disposeFailed = true;
        }
        if (!disposeFailed) {
          host.scopes.delete(scope);
        }
      }
      if (host.scopes.size === 0) {
        closed = true;
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "GOVERNOR_AGENT_LOOP_SCOPE_PROVIDER_CLOSE_FAILED");
      }
    },
  });
}
