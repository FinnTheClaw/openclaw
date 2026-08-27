import { isDeepStrictEqual } from "node:util";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayBehaviorGovernorHostFactory } from "./behavior-governor-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { createBuiltInBehaviorGovernorModules } from "./behavior-governor-module-plan.js";
import { createDeepProductiveLoopActivator } from "./behavior-governor-modules/deep-productive-loop-activation.js";

export type GatewayBehaviorGovernorRuntime = Readonly<{
  apply: (config: OpenClawConfig) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

function configuredModules(config: OpenClawConfig): readonly BehaviorGovernorModuleSelection[] {
  const value = config.experimental?.behaviorGovernor;
  if (!value) {
    return [];
  }
  return "modules" in value && Array.isArray(value.modules) ? value.modules : [];
}

export function createGatewayBehaviorGovernorRuntime(params: {
  hostFactory?: GatewayBehaviorGovernorHostFactory;
}): GatewayBehaviorGovernorRuntime {
  let activeModuleConfig: OpenClawConfig | undefined;
  const activateDeepProductiveLoop = createDeepProductiveLoopActivator({
    getConfig: () => activeModuleConfig,
    hostFactory: params.hostFactory,
  });
  const modules = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: createBuiltInBehaviorGovernorModules({ activateDeepProductiveLoop }),
  });

  const apply = async (config: OpenClawConfig) => {
    if (activeModuleConfig && !isDeepStrictEqual(activeModuleConfig, config)) {
      throw new Error("GOVERNOR_MODULE_RESTART_REQUIRED");
    }
    const selections = configuredModules(config);
    const priorConfig = activeModuleConfig;
    activeModuleConfig = config;
    try {
      await modules.apply(selections);
    } catch (error) {
      activeModuleConfig = priorConfig;
      throw error;
    }
  };

  const freeze = () => modules.freeze();

  const close = async () => {
    await modules.close();
    activeModuleConfig = undefined;
  };

  return Object.freeze({ apply, freeze, close });
}
