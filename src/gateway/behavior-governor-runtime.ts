import { fencePriorGatewayAcceptanceReceipts } from "../agents/subagent-gateway-acceptance-receipt-recovery.sqlite.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "../agents/subagent-gateway-acceptance-receipt-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { getActiveSecretsRuntimeGovernorSnapshot } from "../secrets/runtime-state.js";
import type {
  GatewayBehaviorGovernorHostFactory,
  GatewayBehaviorGovernorLifecycle,
} from "./behavior-governor-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { BUILT_IN_BEHAVIOR_GOVERNOR_MODULES } from "./behavior-governor-module-plan.js";

export type GatewayBehaviorGovernorRuntime = Readonly<{
  apply: (config: OpenClawConfig) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

function isLegacyGovernorEnabled(config: OpenClawConfig): boolean {
  const value = config.experimental?.behaviorGovernor;
  return Boolean(value && "enabled" in value && value.enabled);
}

export function createGatewayBehaviorGovernorRuntime(params: {
  hostFactory?: GatewayBehaviorGovernorHostFactory;
}): GatewayBehaviorGovernorRuntime {
  const modules = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: BUILT_IN_BEHAVIOR_GOVERNOR_MODULES,
  });
  let legacy: GatewayBehaviorGovernorLifecycle | undefined;

  const apply = async (config: OpenClawConfig) => {
    const configured = config.experimental?.behaviorGovernor;
    const selections = configured && "modules" in configured ? configured.modules : [];
    await modules.apply(selections);
    const enabled = isLegacyGovernorEnabled(config);
    if (!enabled && !legacy) {
      return;
    }
    if (!legacy) {
      const { createGatewayBehaviorGovernorLifecycle } =
        await import("./behavior-governor-lifecycle.js");
      legacy = createGatewayBehaviorGovernorLifecycle(
        params.hostFactory ? { hostFactory: params.hostFactory } : {},
      );
    }
    const snapshot = getActiveSecretsRuntimeGovernorSnapshot();
    if (!snapshot) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_REQUIRED");
    }
    await legacy.apply(config, snapshot);
    const receiptSigningKey = snapshot.config.secretRefs.receiptSigningKey;
    if (typeof receiptSigningKey !== "string" || !receiptSigningKey.trim()) {
      throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNER_INVALID");
    }
    installGatewayAcceptanceReceiptSigner({
      signingKey: receiptSigningKey,
      generation: snapshot.generation,
    });
    fencePriorGatewayAcceptanceReceipts(getAgentEventLifecycleGeneration());
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
    if (legacy) {
      try {
        await legacy.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await modules.close();
    } catch (error) {
      errors.push(error);
    }
    clearGatewayAcceptanceReceiptSigner();
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_GATEWAY_CLOSE_FAILED");
    }
    legacy = undefined;
  };

  return Object.freeze({ apply, freeze, close });
}
