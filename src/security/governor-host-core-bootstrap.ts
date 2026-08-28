import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { createGovernorControllerIfEnabled } from "../tasks/governor/controller-bootstrap.js";
import { isBehaviorGovernorEnabled } from "../tasks/governor/feature-flag.js";
import { GovernorRuntimeAdapter } from "../tasks/governor/runtime-adapter.js";
import { GovernorStoreLifecycle } from "../tasks/governor/store-lifecycle.js";
import type { GovernorAgentLoopHostLifecycle } from "./governor-agent-loop-admission.js";
import { validateGovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import {
  installGovernorAgentLoopHost,
  type GovernorAgentLoopConfiguration,
} from "./governor-agent-loop-host.js";
import { createHostGovernorBroker } from "./governor-host-broker.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import { resolveGovernorSecrets } from "./governor-host-secrets.js";

function aggregateWithCause(errors: unknown[], message: string, cause: unknown): AggregateError {
  return new AggregateError(errors, message, { cause });
}

/** Core governed-run bindings have no delivery or authenticated owner ingress. */
export type GovernorHostCoreRuntime = Readonly<{
  adapter: GovernorRuntimeAdapter;
  freeze: () => void;
  close: () => void;
}>;

/**
 * Creates the production governed-run host without constructing Signal/iMessage
 * ingress, delivery registrations, or owner capabilities. Those remain a
 * separate extension for descriptors that explicitly require them.
 */
export function createGovernorHostCoreRuntimeIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  agentLoop: GovernorAgentLoopConfiguration;
}): GovernorHostCoreRuntime | null {
  const env = params.env ?? process.env;
  if (params.enabled !== true && !isBehaviorGovernorEnabled(env)) {
    return null;
  }
  const agentLoop = validateGovernorAgentLoopConfiguration(params.agentLoop, params.capabilities);
  const secrets = resolveGovernorSecrets(env);
  const stateEnv = {
    ...env,
    ...(params.stateDir ? { OPENCLAW_STATE_DIR: params.stateDir } : {}),
  };
  const lifecycle = new GovernorStoreLifecycle({ env: stateEnv });
  let persistence: ReturnType<typeof createGovernorHostPersistence> | undefined;
  let broker: ReturnType<typeof createHostGovernorBroker> | undefined;
  let controller: NonNullable<ReturnType<typeof createGovernorControllerIfEnabled>> | undefined;
  let agentLoopLifecycle: GovernorAgentLoopHostLifecycle | undefined;
  try {
    persistence = createGovernorHostPersistence({
      env,
      stateDir: params.stateDir,
      secrets,
      lifecycle,
    });
    broker = createHostGovernorBroker({ secrets, persistence });
    const created = createGovernorControllerIfEnabled({
      ...params,
      env,
      hostBindings: {
        receiptResolver: broker.resolver,
        evidenceInvalidationResolver: broker.evidenceInvalidationResolver,
        approvalResolver: broker.approvalResolver,
        deliveryResolver: broker.deliveryResolver,
        ownerIngressResolver: broker.ownerIngressResolver,
        physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
        memoryAuthority: broker.memoryAuthority,
        taskAuthority: broker.taskAuthority,
        secrets,
        stateEnv,
        lifecycle,
      },
    });
    if (!created) {
      throw new Error("GOVERNOR_HOST_CONTROLLER_UNAVAILABLE");
    }
    controller = created;
    agentLoopLifecycle = installGovernorAgentLoopHost({
      controller,
      submitObservedReceipt: broker.capabilities.submitObservedReceipt,
      capabilities: params.capabilities,
      config: agentLoop,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const close of [
      () => agentLoopLifecycle?.close(),
      () => controller?.close(),
      () => broker?.close(),
      () => (persistence ? persistence.close() : lifecycle.close()),
    ]) {
      try {
        close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw aggregateWithCause(
        [error, ...cleanupErrors],
        "GOVERNOR_HOST_CORE_STARTUP_CLEANUP_FAILED",
        error,
      );
    }
    throw error;
  }
  if (!broker || !controller) {
    throw new Error("GOVERNOR_HOST_CORE_UNAVAILABLE");
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
    for (const closePart of [
      () => lifecycle.freezeAdmissions(),
      () => agentLoopLifecycle?.close(),
      () => controller?.close(),
      () => broker?.close(),
      () => persistence?.close(),
    ]) {
      try {
        closePart();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      closeFailure = new AggregateError(errors, "GOVERNOR_HOST_CORE_CLOSE_FAILED");
      throw closeFailure;
    }
    closed = true;
  };
  let adapter: GovernorRuntimeAdapter;
  try {
    adapter = new GovernorRuntimeAdapter(controller, broker.ownerIngressResolver);
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw aggregateWithCause([error, cleanupError], "GOVERNOR_HOST_CORE_STARTUP_FAILED", error);
    }
    throw error;
  }
  return Object.freeze({
    adapter,
    freeze: () => {
      lifecycle.freezeAdmissions();
      agentLoopLifecycle?.freezeAdmission();
    },
    close,
  });
}
