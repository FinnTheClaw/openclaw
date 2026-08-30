import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorSqliteStore } from "../tasks/governor/store.js";

export type GatewayBehaviorGovernorModuleHostRegistration = Readonly<{
  id: string;
  version: string;
  bind: (
    host: Readonly<{
      controller: GovernorController;
      store: GovernorSqliteStore;
      capabilities: readonly GovernorCapabilityDefinition[];
      systemdInvocationId?: string;
      seal: (value: GovernorJsonValue) => string;
    }>,
  ) => Readonly<{
    wrap: (
      input: Readonly<{
        scope: GovernorAgentLoopRunScope;
        run: GovernorAgentLoopRunInput;
        config: GovernorAgentLoopConfiguration;
        modulePlanDigest: string;
        hostDescriptorDigest: string;
      }>,
    ) => GovernorAgentLoopRunScope;
    close: () => void;
  }>;
}>;
