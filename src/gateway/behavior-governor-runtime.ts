import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayBehaviorGovernorHostFactory } from "./behavior-governor-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { createBuiltInBehaviorGovernorModules } from "./behavior-governor-module-plan.js";
import { createC04bAggregateOrderActivator } from "./behavior-governor-modules/c04b-aggregate-order-activation.js";

export type GatewayBehaviorGovernorRuntime = Readonly<{
  apply: (config: OpenClawConfig) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

function configuredModules(config: OpenClawConfig) {
  const value = config.experimental?.behaviorGovernor;
  return value && "modules" in value && Array.isArray(value.modules) ? value.modules : [];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function createGatewayBehaviorGovernorRuntime(params: {
  hostFactory?: GatewayBehaviorGovernorHostFactory;
}): GatewayBehaviorGovernorRuntime {
  let activeConfig: OpenClawConfig | undefined;
  const activateC04bAggregateOrder = createC04bAggregateOrderActivator({
    getConfig: () => activeConfig,
    hostFactory: params.hostFactory,
  });
  const modules = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: createBuiltInBehaviorGovernorModules({ activateC04bAggregateOrder }),
  });

  const apply = async (config: OpenClawConfig) => {
    if (activeConfig && !isDeepStrictEqual(activeConfig, config)) {
      throw new Error("GOVERNOR_MODULE_RESTART_REQUIRED");
    }
    const accepted = deepFreeze(structuredClone(config));
    const prior = activeConfig;
    activeConfig = accepted;
    try {
      await modules.apply(configuredModules(accepted));
    } catch (error) {
      activeConfig = prior;
      throw error;
    }
  };

  const freeze = async () => {
    const errors: unknown[] = [];
    try {
      await modules.freeze();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_GATEWAY_FREEZE_FAILED");
    }
  };

  const close = async () => {
    const errors: unknown[] = [];
    try {
      await modules.close();
    } catch (error) {
      errors.push(error);
    }
    activeConfig = undefined;
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_GATEWAY_CLOSE_FAILED");
    }
  };

  return Object.freeze({ apply, freeze, close });
}
