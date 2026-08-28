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
  GatewayBehaviorGovernorPolicy,
} from "./behavior-governor-lifecycle.js";
import {
  createGatewayBehaviorGovernorModuleLifecycle,
  resolveGatewayBehaviorGovernorModulePlan,
  type GatewayBehaviorGovernorModuleDescriptor,
} from "./behavior-governor-module-lifecycle.js";
import { BUILT_IN_BEHAVIOR_GOVERNOR_MODULES } from "./behavior-governor-module-plan.js";
import { resolveSelectedGovernorCoreRequirements } from "./behavior-governor-production-host.js";

export type GatewayBehaviorGovernorRuntime = Readonly<{
  apply: (config: OpenClawConfig) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

export function createGatewayBehaviorGovernorRuntime(params: {
  hostFactory?: GatewayBehaviorGovernorHostFactory;
  catalog?: readonly GatewayBehaviorGovernorModuleDescriptor[];
}): GatewayBehaviorGovernorRuntime {
  const catalog = params.catalog ?? BUILT_IN_BEHAVIOR_GOVERNOR_MODULES;
  const modules = createGatewayBehaviorGovernorModuleLifecycle({
    catalog,
  });
  let core: GatewayBehaviorGovernorLifecycle | undefined;

  const apply = async (config: OpenClawConfig) => {
    const configured = config.experimental?.behaviorGovernor;
    const selections = configured && "modules" in configured ? (configured.modules ?? []) : [];
    await modules.apply(selections);
    const plan = resolveGatewayBehaviorGovernorModulePlan({ catalog, selections });
    const requirements = resolveSelectedGovernorCoreRequirements(plan);
    if (!requirements) {
      return;
    }
    if (!params.hostFactory) {
      throw new Error("GOVERNOR_GATEWAY_PRODUCTION_HOST_REQUIRED");
    }
    if (!core) {
      const { createGatewayBehaviorGovernorLifecycle } =
        await import("./behavior-governor-lifecycle.js");
      core = createGatewayBehaviorGovernorLifecycle({ hostFactory: params.hostFactory });
    }
    const snapshot = getActiveSecretsRuntimeGovernorSnapshot();
    if (!snapshot) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_REQUIRED");
    }
    await core.apply(config, snapshot, {
      requirements,
      preparePolicy: (policy) => prepareSelectedPolicy(policy, plan),
    });
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
      await core?.freeze();
    } catch (error) {
      errors.push(error);
    }
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
    if (core) {
      try {
        await core.close();
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
    core = undefined;
  };

  return Object.freeze({ apply, freeze, close });
}

function prepareSelectedPolicy(
  policy: GatewayBehaviorGovernorPolicy,
  plan: readonly ReturnType<typeof resolveGatewayBehaviorGovernorModulePlan>[number][],
): GatewayBehaviorGovernorPolicy {
  let prepared = policy;
  for (const module of plan) {
    if (module.descriptor.preparePolicy) {
      prepared = module.descriptor.preparePolicy(deepFreeze(structuredClone(prepared)));
    }
  }
  return prepared;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
