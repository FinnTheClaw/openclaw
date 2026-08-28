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
import type { C04bAggregateOrderActivator } from "./c04b-aggregate-order.js";

type GovernorSnapshot = NonNullable<ReturnType<typeof getActiveSecretsRuntimeGovernorSnapshot>>;

export type C04bAggregateOrderActivationServices = Readonly<{
  clearSigner: () => void;
  createLifecycle: (params: {
    hostFactory: GatewayBehaviorGovernorHostFactory;
  }) => GatewayBehaviorGovernorLifecycle;
  fenceReceipts: (generation: string) => unknown;
  getGeneration: () => string;
  getSnapshot: () => GovernorSnapshot | null;
  installSigner: (params: { signingKey: string; generation: string }) => void;
}>;

const defaultServices: C04bAggregateOrderActivationServices = Object.freeze({
  clearSigner: clearGatewayAcceptanceReceiptSigner,
  createLifecycle: createGatewayBehaviorGovernorLifecycle,
  fenceReceipts: fencePriorGatewayAcceptanceReceipts,
  getGeneration: getAgentEventLifecycleGeneration,
  getSnapshot: getActiveSecretsRuntimeGovernorSnapshot,
  installSigner: installGatewayAcceptanceReceiptSigner,
});

function activationRollbackError(cause: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError([cause, cleanupError], "GOVERNOR_C04B_ACTIVATION_ROLLBACK_FAILED", {
    cause,
  });
}

export function prepareC04bAggregateOrderConfig(
  config: OpenClawConfig | undefined,
  mode: "shadow" | "enforce",
): OpenClawConfig {
  const governor = config?.experimental?.behaviorGovernor;
  if (!governor || !("enabled" in governor) || !governor.enabled || governor.mode !== mode) {
    throw new Error("GOVERNOR_C04B_CONFIGURATION_REQUIRED");
  }
  const criteria = governor.agentLoop.criteria;
  const aggregate = criteria.find((criterion) => criterion.criterionId === "aggregate");
  if (!aggregate) {
    throw new Error("GOVERNOR_C04B_AGGREGATE_CRITERION_REQUIRED");
  }
  const dependencies = [
    ...new Set([
      ...(aggregate.dependsOnCriteria ?? []),
      ...criteria
        .filter((criterion) => criterion.criterionId !== "aggregate")
        .map((criterion) => criterion.criterionId),
    ]),
  ].toSorted();
  return {
    ...config,
    experimental: {
      ...config.experimental,
      behaviorGovernor: {
        ...governor,
        agentLoop: {
          ...governor.agentLoop,
          criteria: criteria.map((criterion) => {
            if (criterion.criterionId !== "aggregate") {
              return criterion;
            }
            return {
              criterionId: criterion.criterionId,
              description: criterion.description,
              dependsOnCriteria: dependencies,
            };
          }),
        },
      },
    },
  } as OpenClawConfig;
}

/** Transactional selected-module activation; C04B owns only its ordering transformation. */
export function createC04bAggregateOrderActivator(params: {
  getConfig: () => OpenClawConfig | undefined;
  hostFactory?: GatewayBehaviorGovernorHostFactory;
  services?: C04bAggregateOrderActivationServices;
}): C04bAggregateOrderActivator {
  const services = params.services ?? defaultServices;
  return async (context) => {
    const config = prepareC04bAggregateOrderConfig(params.getConfig(), context.mode);
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
    const lifecycle = services.createLifecycle({ hostFactory: params.hostFactory });
    let signerInstalled = false;
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
        if (signerInstalled && !signerCleared) {
          try {
            services.clearSigner();
            signerCleared = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "GOVERNOR_C04B_CLOSE_FAILED");
        }
      },
    });
    try {
      signerInstalled = true;
      services.installSigner({ signingKey, generation: snapshot.generation });
      services.fenceReceipts(services.getGeneration());
      await lifecycle.apply(config, snapshot);
    } catch (error) {
      try {
        await runtime.close();
      } catch (cleanupError) {
        throw activationRollbackError(error, cleanupError);
      }
      throw error;
    }
    return runtime;
  };
}
