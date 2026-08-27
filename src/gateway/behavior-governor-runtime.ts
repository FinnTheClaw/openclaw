import { fencePriorGatewayAcceptanceReceipts } from "../agents/subagent-gateway-acceptance-receipt-recovery.sqlite.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "../agents/subagent-gateway-acceptance-receipt-runtime.js";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { getActiveSecretsRuntimeGovernorSnapshot } from "../secrets/runtime-state.js";
import type {
  GatewayBehaviorGovernorHostFactory,
  GatewayBehaviorGovernorLifecycle,
} from "./behavior-governor-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { createBuiltInBehaviorGovernorModules } from "./behavior-governor-module-plan.js";
import type { DeepProductiveLoopActivator } from "./behavior-governor-modules/deep-productive-loop.js";

export type GatewayBehaviorGovernorRuntime = Readonly<{
  apply: (config: OpenClawConfig) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

function isLegacyGovernorEnabled(config: OpenClawConfig): boolean {
  const value = config.experimental?.behaviorGovernor;
  return Boolean(value && "enabled" in value && value.enabled);
}

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
  let legacy: GatewayBehaviorGovernorLifecycle | undefined;
  const activateDeepProductiveLoop: DeepProductiveLoopActivator = async (context) => {
    const config = activeModuleConfig;
    if (!config || !isLegacyGovernorEnabled(config)) {
      throw new Error("GOVERNOR_C03_CONFIGURATION_REQUIRED");
    }
    const configured = config.experimental?.behaviorGovernor;
    if (
      !configured ||
      !("enabled" in configured) ||
      configured.enabled !== true ||
      configured.mode !== context.mode
    ) {
      throw new Error("GOVERNOR_C03_MODE_MISMATCH");
    }
    if (!params.hostFactory) {
      throw new Error("GOVERNOR_GATEWAY_HOST_INTEGRATION_REQUIRED");
    }
    const snapshot = getActiveSecretsRuntimeGovernorSnapshot();
    if (!snapshot) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_REQUIRED");
    }
    if (!legacy) {
      const { createGatewayBehaviorGovernorLifecycle } =
        await import("./behavior-governor-lifecycle.js");
      legacy = createGatewayBehaviorGovernorLifecycle({ hostFactory: params.hostFactory });
    }
    const active = legacy;
    await active.apply(config, snapshot);
    const receiptSigningKey = snapshot.config.secretRefs.receiptSigningKey;
    if (typeof receiptSigningKey !== "string" || !receiptSigningKey.trim()) {
      throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNER_INVALID");
    }
    installGatewayAcceptanceReceiptSigner({
      signingKey: receiptSigningKey,
      generation: snapshot.generation,
    });
    fencePriorGatewayAcceptanceReceipts(getAgentEventLifecycleGeneration());
    return Object.freeze({
      freeze: () => active.freeze(),
      close: async () => {
        await active.close();
        if (legacy === active) {
          legacy = undefined;
        }
      },
    });
  };
  const modules = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: createBuiltInBehaviorGovernorModules({ activateDeepProductiveLoop }),
  });

  const apply = async (config: OpenClawConfig) => {
    const selections = configuredModules(config);
    activeModuleConfig = config;
    await modules.apply(selections);
  };

  const freeze = async () => {
    const errors: unknown[] = [];
    try {
      await modules.freeze();
    } catch (error) {
      errors.push(error);
    }
    try {
      await legacy?.freeze();
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
    if (legacy) {
      try {
        await legacy.close();
      } catch (error) {
        errors.push(error);
      }
    }
    clearGatewayAcceptanceReceiptSigner();
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_GATEWAY_CLOSE_FAILED");
    }
    activeModuleConfig = undefined;
    legacy = undefined;
  };

  return Object.freeze({ apply, freeze, close });
}
