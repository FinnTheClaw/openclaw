import { fencePriorGatewayAcceptanceReceipts } from "../../agents/subagent-gateway-acceptance-receipt-recovery.sqlite.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "../../agents/subagent-gateway-acceptance-receipt-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getActiveSecretsRuntimeGovernorSnapshot } from "../../secrets/runtime-state.js";
import {
  createGatewayBehaviorGovernorLifecycle,
  type GatewayBehaviorGovernorHostFactory,
  type GatewayBehaviorGovernorLifecycle,
} from "../behavior-governor-lifecycle.js";
import { GatewayBehaviorGovernorModuleStartupError } from "../behavior-governor-module-lifecycle.js";
import type { DeepProductiveLoopActivator } from "./deep-productive-loop.js";

type GovernorSnapshot = NonNullable<ReturnType<typeof getActiveSecretsRuntimeGovernorSnapshot>>;

export type DeepProductiveLoopActivationServices = Readonly<{
  clearSigner: () => void;
  createLifecycle: (params: {
    hostFactory: GatewayBehaviorGovernorHostFactory;
  }) => GatewayBehaviorGovernorLifecycle;
  fenceReceipts: (generation: string) => unknown;
  getGeneration: () => string;
  getSnapshot: () => GovernorSnapshot | null;
  installSigner: (params: { signingKey: string; generation: string }) => void;
}>;

const defaultServices: DeepProductiveLoopActivationServices = Object.freeze({
  clearSigner: clearGatewayAcceptanceReceiptSigner,
  createLifecycle: createGatewayBehaviorGovernorLifecycle,
  fenceReceipts: fencePriorGatewayAcceptanceReceipts,
  getGeneration: getAgentEventLifecycleGeneration,
  getSnapshot: getActiveSecretsRuntimeGovernorSnapshot,
  installSigner: installGatewayAcceptanceReceiptSigner,
});

function enabledConfig(
  config: OpenClawConfig | undefined,
  mode: "shadow" | "enforce",
): OpenClawConfig {
  const governor = config?.experimental?.behaviorGovernor;
  if (!governor || !("enabled" in governor) || !governor.enabled) {
    throw new Error("GOVERNOR_C03_CONFIGURATION_REQUIRED");
  }
  if (governor.mode !== mode) {
    throw new Error("GOVERNOR_C03_MODE_MISMATCH");
  }
  return config;
}

/** Transactional C03 activation. No enforcement becomes live before setup completes. */
export function createDeepProductiveLoopActivator(params: {
  getConfig: () => OpenClawConfig | undefined;
  hostFactory?: GatewayBehaviorGovernorHostFactory;
  services?: DeepProductiveLoopActivationServices;
}): DeepProductiveLoopActivator {
  const services = params.services ?? defaultServices;
  return async (context) => {
    const config = enabledConfig(params.getConfig(), context.mode);
    if (!params.hostFactory) {
      throw new Error("GOVERNOR_GATEWAY_HOST_INTEGRATION_REQUIRED");
    }
    const snapshot = services.getSnapshot();
    if (!snapshot) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_REQUIRED");
    }
    const signingKey = snapshot.config.secretRefs.receiptSigningKey;
    if (typeof signingKey !== "string" || !signingKey.trim()) {
      throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNER_INVALID");
    }
    const receiptGeneration = services.getGeneration();
    const lifecycle = services.createLifecycle({ hostFactory: params.hostFactory });
    let signerAttempted = false;
    let lifecycleClosed = false;
    let signerCleared = false;
    const runtime = Object.freeze({
      freeze: () => lifecycle.freeze(),
      close: async () => {
        const errors: unknown[] = [];
        if (!lifecycleClosed) {
          try {
            await lifecycle.close();
            lifecycleClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (signerAttempted && !signerCleared) {
          try {
            services.clearSigner();
            signerCleared = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "GOVERNOR_C03_CLOSE_FAILED");
        }
      },
    });
    try {
      signerAttempted = true;
      services.installSigner({ signingKey, generation: snapshot.generation });
      services.fenceReceipts(receiptGeneration);
      await lifecycle.apply(config, snapshot);
    } catch (error) {
      try {
        await runtime.close();
      } catch (cleanupError) {
        throw new GatewayBehaviorGovernorModuleStartupError({
          moduleId: context.id,
          runtime,
          activation: context,
          cause: new AggregateError(
            [error, cleanupError],
            "GOVERNOR_C03_ACTIVATION_ROLLBACK_FAILED",
            { cause: error },
          ),
        });
      }
      throw error;
    }
    return runtime;
  };
}
