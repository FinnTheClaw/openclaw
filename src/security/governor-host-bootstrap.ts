import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { createGovernorControllerIfEnabled } from "../tasks/governor/controller-bootstrap.js";
import { isBehaviorGovernorEnabled } from "../tasks/governor/feature-flag.js";
import { GovernorRuntimeAdapter } from "../tasks/governor/runtime-adapter.js";
import { GovernorStoreLifecycle } from "../tasks/governor/store-lifecycle.js";
import { validateGovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import {
  installGovernorAgentLoopHost,
  type GovernorAgentLoopConfiguration,
} from "./governor-agent-loop-host.js";
/** Trusted host bootstrap for feature-gated governor read-only bindings. */
import { createHostGovernorBroker } from "./governor-host-broker.js";
import { createGovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import { createCompiledOwnerIngress } from "./governor-host-owner-ingress.js";
import type { GovernorOwnerIngressBinding } from "./governor-host-owner-ingress.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import { resolveGovernorSecrets } from "./governor-host-secrets.js";

function aggregateWithCause(errors: unknown[], message: string, cause: unknown): AggregateError {
  return new AggregateError(errors, message, { cause });
}

export type GovernorHostIntegrationConfiguration = Readonly<{
  evidenceOwnerId: string;
  approvalOwnerId: string;
  deliveryOwnerId: string;
  ownerIngressOwnerId: string;
  childOwnerId: string;
  ownerIngressBindings: readonly GovernorOwnerIngressBinding[];
  agentLoop?: GovernorAgentLoopConfiguration;
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
      submitEvidenceInvalidation: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["submitEvidenceInvalidation"];
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
      resolveUnknownDelivery: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["resolveUnknownDelivery"];
    }>;
    ownerIngress: Readonly<{
      ownerId: string;
      submitSignal: ReturnType<typeof createCompiledOwnerIngress>["submitSignal"];
      submitIMessage: ReturnType<typeof createCompiledOwnerIngress>["submitIMessage"];
      revokeReceipt: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["revokeOwnerIngressReceipt"];
    }>;
    child: Readonly<{
      ownerId: string;
      submitLifecycleReceipt: ReturnType<
        typeof createHostGovernorBroker
      >["capabilities"]["submitObservedReceipt"];
    }>;
  }>;
  deliveryHandles: readonly ReturnType<
    ReturnType<typeof createHostGovernorBroker>["capabilities"]["registerStaticDeliveryAdapter"]
  >[];
  freeze: () => void;
  close: () => void;
}>;

function assertOwner(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Governor ${label} integration owner is required`);
  }
}

function isChildLifecyclePayload(value: GovernorJsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const kind = value.kind;
  return (
    kind === "governor_external_child_registration" ||
    kind === "governor_external_child_terminal" ||
    kind === "governor_physical_execution_termination"
  );
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
  testMode?: boolean;
  testAfterPersistenceCreated?: () => void;
  testPersistenceClose?: () => void;
}) {
  if (
    (params.testAfterPersistenceCreated || params.testPersistenceClose) &&
    params.testMode !== true
  ) {
    throw new Error("Governor host bootstrap test hooks are unavailable outside tests");
  }
  assertOwner(params.integrations.evidenceOwnerId, "evidence");
  assertOwner(params.integrations.approvalOwnerId, "approval");
  assertOwner(params.integrations.deliveryOwnerId, "delivery");
  assertOwner(params.integrations.ownerIngressOwnerId, "owner ingress");
  assertOwner(params.integrations.childOwnerId, "child lifecycle");
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
  const stateEnv = {
    ...params.env,
    ...(params.stateDir ? { OPENCLAW_STATE_DIR: params.stateDir } : {}),
  };
  const lifecycle = new GovernorStoreLifecycle({ env: stateEnv });
  let persistence: ReturnType<typeof createGovernorHostPersistence>;
  try {
    persistence = createGovernorHostPersistence({
      env: params.env,
      stateDir: params.stateDir,
      secrets,
      lifecycle,
      testMode: params.testMode,
      testClose: params.testPersistenceClose,
    });
  } catch (error) {
    try {
      lifecycle.close();
    } catch (cleanupError) {
      throw aggregateWithCause(
        [error, cleanupError],
        "GOVERNOR_HOST_PERSISTENCE_STARTUP_CLEANUP_FAILED",
        error,
      );
    }
    throw error;
  }
  let broker: ReturnType<typeof createHostGovernorBroker>;
  try {
    params.testAfterPersistenceCreated?.();
    broker = createHostGovernorBroker({
      secrets,
      persistence,
      ...(deliveryRuntime ? { deliveryRuntime } : {}),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      persistence.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw aggregateWithCause(
        [error, ...cleanupErrors],
        "GOVERNOR_HOST_BROKER_STARTUP_CLEANUP_FAILED",
        error,
      );
    }
    throw error;
  }
  const submitChildLifecycleReceipt: ReturnType<
    typeof createHostGovernorBroker
  >["capabilities"]["submitObservedReceipt"] = (input) => {
    if (input.sourceKind !== "structured_external" || !isChildLifecyclePayload(input.payload)) {
      throw new Error("Governor child owner accepts only child lifecycle observations");
    }
    return broker.capabilities.submitObservedReceipt(input);
  };
  const owners = Object.freeze({
    evidence: Object.freeze({
      ownerId: params.integrations.evidenceOwnerId,
      submitObservedReceipt: broker.capabilities.submitObservedReceipt,
      submitEvidenceInvalidation: broker.capabilities.submitEvidenceInvalidation,
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
      resolveUnknownDelivery: broker.capabilities.resolveUnknownDelivery,
    }),
    ownerIngress: Object.freeze({
      ownerId: params.integrations.ownerIngressOwnerId,
      ...createCompiledOwnerIngress(
        broker.capabilities.submitAuthenticatedOwnerIngress,
        params.integrations.ownerIngressBindings,
      ),
      revokeReceipt: broker.capabilities.revokeOwnerIngressReceipt,
    }),
    child: Object.freeze({
      ownerId: params.integrations.childOwnerId,
      submitLifecycleReceipt: submitChildLifecycleReceipt,
    }),
  });
  let deliveryHandles: ReturnType<
    ReturnType<typeof createHostGovernorBroker>["capabilities"]["registerStaticDeliveryAdapter"]
  >[];
  try {
    deliveryHandles = params.integrations.deliveries.map((registration) =>
      owners.delivery.registerStaticDeliveryAdapter(registration),
    );
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      broker.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      persistence.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw aggregateWithCause(
        [error, ...cleanupErrors],
        "GOVERNOR_HOST_DELIVERY_STARTUP_CLEANUP_FAILED",
        error,
      );
    }
    throw error;
  }
  let closed = false;
  let closeFailure: AggregateError | undefined;
  const close = () => {
    if (closeFailure) {
      throw closeFailure;
    }
    if (closed) {
      return;
    }
    const errors: unknown[] = [];
    try {
      broker.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      persistence.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      closeFailure = new AggregateError(errors, "GOVERNOR_HOST_BINDINGS_CLOSE_FAILED");
      throw closeFailure;
    }
    closed = true;
  };
  return {
    resolver: broker.resolver,
    evidenceInvalidationResolver: broker.evidenceInvalidationResolver,
    approvalResolver: broker.approvalResolver,
    deliveryResolver: broker.deliveryResolver,
    ownerIngressResolver: broker.ownerIngressResolver,
    physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
    memoryAuthority: broker.memoryAuthority,
    taskAuthority: broker.taskAuthority,
    secrets,
    owners,
    deliveryHandles: Object.freeze(deliveryHandles),
    lifecycle,
    freeze: broker.freeze,
    close,
  };
}

/**
 * The host-owned activation path. Task-facing governor modules never create
 * host capabilities or import this bootstrap module.
 */
export function createGovernorHostRuntimeIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  integrations?: GovernorHostIntegrationConfiguration;
}): GovernorHostRuntime | null {
  const env = params.env ?? process.env;
  if (params.enabled !== true && !isBehaviorGovernorEnabled(env)) {
    return null;
  }
  if (!params.integrations) {
    throw new Error("Authenticated governor integration owners are required");
  }
  const agentLoop = params.integrations.agentLoop
    ? validateGovernorAgentLoopConfiguration(params.integrations.agentLoop, params.capabilities)
    : undefined;
  const bindings = createGovernorHostRuntimeBindings({
    env,
    stateDir: params.stateDir,
    integrations: params.integrations,
  });
  let closeAgentLoop = () => {};
  let controller: NonNullable<ReturnType<typeof createGovernorControllerIfEnabled>> | undefined;
  try {
    const created = createGovernorControllerIfEnabled({
      ...params,
      env,
      hostBindings: {
        receiptResolver: bindings.resolver,
        evidenceInvalidationResolver: bindings.evidenceInvalidationResolver,
        approvalResolver: bindings.approvalResolver,
        deliveryResolver: bindings.deliveryResolver,
        ownerIngressResolver: bindings.ownerIngressResolver,
        physicalExecutionCoordinator: bindings.physicalExecutionCoordinator,
        memoryAuthority: bindings.memoryAuthority,
        taskAuthority: bindings.taskAuthority,
        secrets: bindings.secrets,
        stateEnv: env,
        lifecycle: bindings.lifecycle,
      },
    });
    if (!created) {
      throw new Error("Enabled governor controller failed to initialize");
    }
    controller = created;
    closeAgentLoop = agentLoop
      ? installGovernorAgentLoopHost({
          controller,
          submitObservedReceipt: bindings.owners.evidence.submitObservedReceipt,
          capabilities: params.capabilities,
          config: agentLoop,
        })
      : () => {};
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      closeAgentLoop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      controller?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      bindings.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw aggregateWithCause(
        [error, ...cleanupErrors],
        "GOVERNOR_HOST_RUNTIME_STARTUP_CLEANUP_FAILED",
        error,
      );
    }
    throw error;
  }
  if (!controller) {
    throw new Error("GOVERNOR_HOST_CONTROLLER_UNAVAILABLE");
  }
  let closed = false;
  let closeFailure: AggregateError | undefined;
  const close = () => {
    if (closeFailure) {
      throw closeFailure;
    }
    if (closed) {
      return;
    }
    const errors: unknown[] = [];
    try {
      bindings.freeze();
    } catch (error) {
      errors.push(error);
    }
    try {
      closeAgentLoop();
    } catch (error) {
      errors.push(error);
    }
    try {
      controller.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      bindings.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      closeFailure = new AggregateError(errors, "GOVERNOR_HOST_RUNTIME_CLOSE_FAILED");
      throw closeFailure;
    }
    closed = true;
  };
  let adapter: GovernorRuntimeAdapter;
  try {
    adapter = new GovernorRuntimeAdapter(controller, bindings.ownerIngressResolver);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      closeAgentLoop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      controller.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      bindings.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw aggregateWithCause(
        [error, ...cleanupErrors],
        "GOVERNOR_HOST_RUNTIME_STARTUP_FAILED",
        error,
      );
    }
    throw error;
  }
  return Object.freeze({
    adapter,
    owners: bindings.owners,
    deliveryHandles: bindings.deliveryHandles,
    freeze: () => bindings.freeze(),
    close,
  });
}

/** Compatibility helper for host sites that need only the task-facing adapter. */
export function createGovernorHostRuntimeAdapterIfEnabled(
  params: Parameters<typeof createGovernorHostRuntimeIfEnabled>[0],
): GovernorRuntimeAdapter | null {
  const env = params.env ?? process.env;
  if (isBehaviorGovernorEnabled(env) && params.integrations?.agentLoop) {
    throw new Error("GOVERNOR_AGENT_LOOP_RUNTIME_LIFECYCLE_REQUIRED");
  }
  return createGovernorHostRuntimeIfEnabled(params)?.adapter ?? null;
}
