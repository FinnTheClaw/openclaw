import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { createGovernorControllerIfEnabled } from "../tasks/governor/controller-bootstrap.js";
import { isBehaviorGovernorEnabled } from "../tasks/governor/feature-flag.js";
import { GovernorRuntimeAdapter } from "../tasks/governor/runtime-adapter.js";
/** Trusted host bootstrap for feature-gated governor read-only bindings. */
import { createHostGovernorBroker } from "./governor-host-broker.js";
import { createGovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import { createCompiledOwnerIngress } from "./governor-host-owner-ingress.js";
import type { GovernorOwnerIngressBinding } from "./governor-host-owner-ingress.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import { resolveGovernorSecrets } from "./governor-host-secrets.js";

export type GovernorHostIntegrationConfiguration = Readonly<{
  evidenceOwnerId: string;
  approvalOwnerId: string;
  deliveryOwnerId: string;
  ownerIngressOwnerId: string;
  ownerIngressBindings: readonly GovernorOwnerIngressBinding[];
  channelConfig?: OpenClawConfig;
  deliveries: readonly Readonly<{
    implementationId: string;
    config: GovernorJsonValue;
    generation: number;
  }>[];
}>;

export type GovernorHostRuntime = Readonly<{
  adapter: GovernorRuntimeAdapter;
  owners: Readonly<{
    evidence: Readonly<{
      ownerId: string;
      submitObservedReceipt: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["submitObservedReceipt"];
    }>;
    approval: Readonly<{
      ownerId: string;
      submitAuthenticatedApproval: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["submitAuthenticatedApproval"];
      submitApprovalRevocation: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["submitApprovalRevocation"];
    }>;
    delivery: Readonly<{
      ownerId: string;
      registerStaticDeliveryAdapter: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["registerStaticDeliveryAdapter"];
      revokeDeliveryAdapter: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["revokeDeliveryAdapter"];
    }>;
    ownerIngress: Readonly<{
      ownerId: string;
      submitSignal: ReturnType<typeof createCompiledOwnerIngress>["submitSignal"];
      submitIMessage: ReturnType<typeof createCompiledOwnerIngress>["submitIMessage"];
    }>;
  }>;
  deliveryHandles: readonly ReturnType<
    ReturnType<typeof createHostGovernorBroker>["capabilities"]["registerStaticDeliveryAdapter"]
  >[];
}>;

function assertOwner(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Governor ${label} integration owner is required`);
  }
}

/**
 * Builds read-only task resolvers plus separate owner capabilities for trusted
 * channel/tool/terminal integrations. Only the trusted host bootstrap receives
 * the owner capabilities; task-facing runtime construction gets the resolvers.
 */
export function createGovernorHostRuntimeBindings(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  integrations: GovernorHostIntegrationConfiguration;
}) {
  assertOwner(params.integrations.evidenceOwnerId, "evidence");
  assertOwner(params.integrations.approvalOwnerId, "approval");
  assertOwner(params.integrations.deliveryOwnerId, "delivery");
  assertOwner(params.integrations.ownerIngressOwnerId, "owner ingress");
  if (params.integrations.ownerIngressBindings.length === 0) {
    throw new Error("At least one authenticated governor owner binding is required");
  }
  if (params.integrations.deliveries.length === 0) {
    throw new Error("At least one certified governor delivery integration is required");
  }
  const secrets = resolveGovernorSecrets(params.env);
  const deliveryRuntime = params.integrations.channelConfig
    ? createGovernorHostDeliveryRuntime({
        cfg: params.integrations.channelConfig,
        stateDir: params.stateDir ?? params.env.OPENCLAW_STATE_DIR ?? "",
        deploymentIdentity: secrets.deploymentIdentity,
        identity: secrets.identity,
      })
    : undefined;
  const broker = createHostGovernorBroker({
    secrets,
    persistence: createGovernorHostPersistence({
      env: params.env,
      stateDir: params.stateDir,
      secrets,
    }),
    ...(deliveryRuntime ? { deliveryRuntime } : {}),
  });
  const owners = Object.freeze({
    evidence: Object.freeze({
      ownerId: params.integrations.evidenceOwnerId,
      submitObservedReceipt: broker.capabilities.submitObservedReceipt,
    }),
    approval: Object.freeze({
      ownerId: params.integrations.approvalOwnerId,
      submitAuthenticatedApproval: broker.capabilities.submitAuthenticatedApproval,
      submitApprovalRevocation: broker.capabilities.submitApprovalRevocation,
    }),
    delivery: Object.freeze({
      ownerId: params.integrations.deliveryOwnerId,
      registerStaticDeliveryAdapter: broker.capabilities.registerStaticDeliveryAdapter,
      revokeDeliveryAdapter: broker.capabilities.revokeDeliveryAdapter,
    }),
    ownerIngress: Object.freeze({
      ownerId: params.integrations.ownerIngressOwnerId,
      ...createCompiledOwnerIngress(
        broker.capabilities.submitAuthenticatedOwnerIngress,
        params.integrations.ownerIngressBindings,
      ),
    }),
  });
  const deliveryHandles = params.integrations.deliveries.map((registration) =>
    owners.delivery.registerStaticDeliveryAdapter(registration),
  );
  return {
    resolver: broker.resolver,
    approvalResolver: broker.approvalResolver,
    deliveryResolver: broker.deliveryResolver,
    ownerIngressResolver: broker.ownerIngressResolver,
    secrets,
    owners,
    deliveryHandles: Object.freeze(deliveryHandles),
  };
}

/**
 * The host-owned activation path. Task-facing governor modules never create
 * host capabilities or import this bootstrap module.
 */
export function createGovernorHostRuntimeIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  integrations?: GovernorHostIntegrationConfiguration;
}): GovernorHostRuntime | null {
  const env = params.env ?? process.env;
  if (!isBehaviorGovernorEnabled(env)) {
    return null;
  }
  if (!params.integrations) {
    throw new Error("Authenticated governor integration owners are required");
  }
  const bindings = createGovernorHostRuntimeBindings({
    env,
    stateDir: params.stateDir,
    integrations: params.integrations,
  });
  const controller = createGovernorControllerIfEnabled({
    ...params,
    env,
    hostBindings: {
      receiptResolver: bindings.resolver,
      approvalResolver: bindings.approvalResolver,
      deliveryResolver: bindings.deliveryResolver,
      ownerIngressResolver: bindings.ownerIngressResolver,
      secrets: bindings.secrets,
      stateEnv: env,
    },
  });
  if (!controller) {
    throw new Error("Enabled governor controller failed to initialize");
  }
  return Object.freeze({
    adapter: new GovernorRuntimeAdapter(controller, bindings.ownerIngressResolver),
    owners: bindings.owners,
    deliveryHandles: bindings.deliveryHandles,
  });
}

/** Compatibility helper for host sites that need only the task-facing adapter. */
export function createGovernorHostRuntimeAdapterIfEnabled(
  params: Parameters<typeof createGovernorHostRuntimeIfEnabled>[0],
): GovernorRuntimeAdapter | null {
  return createGovernorHostRuntimeIfEnabled(params)?.adapter ?? null;
}
