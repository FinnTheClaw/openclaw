import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { createGovernorControllerIfEnabled } from "../tasks/governor/controller-bootstrap.js";
import { isBehaviorGovernorEnabled } from "../tasks/governor/feature-flag.js";
import { GovernorRuntimeAdapter } from "../tasks/governor/runtime-adapter.js";
import { assertGovernorIdentityHmacKeyAvailable } from "../tasks/governor/types.js";
/** Trusted host bootstrap for feature-gated governor read-only bindings. */
import { createHostGovernorBroker } from "./governor-host-broker.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";

const HOST_RECEIPT_KEY_ENV = "OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY";
const HOST_LEDGER_KEY_ENV = "OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY";

/**
 * This returns resolvers only. Host mutation capabilities deliberately remain
 * inside the authenticated channel/tool/terminal integration bootstrap.
 */
export function createGovernorHostRuntimeBindings(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}) {
  const env = { ...process.env, ...params.env };
  const receiptSigningKey = env[HOST_RECEIPT_KEY_ENV]?.trim();
  if (!receiptSigningKey) {
    throw new Error(`${HOST_RECEIPT_KEY_ENV} is required when the behavior governor is enabled`);
  }
  const ledgerKey = env[HOST_LEDGER_KEY_ENV]?.trim();
  if (!ledgerKey) {
    throw new Error(`${HOST_LEDGER_KEY_ENV} is required when the behavior governor is enabled`);
  }
  const broker = createHostGovernorBroker({
    receiptSigningKey,
    persistence: createGovernorHostPersistence({ stateDir: params.stateDir, ledgerKey }),
  });
  return {
    resolver: broker.resolver,
    approvalResolver: broker.approvalResolver,
    deliveryResolver: broker.deliveryResolver,
  };
}

/**
 * The host-owned activation path. Task-facing governor modules never create
 * host capabilities or import this bootstrap module.
 */
export function createGovernorHostRuntimeAdapterIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
}): GovernorRuntimeAdapter | null {
  const env = { ...process.env, ...params.env };
  if (!isBehaviorGovernorEnabled(env)) {
    return null;
  }
  assertGovernorIdentityHmacKeyAvailable(env);
  const bindings = createGovernorHostRuntimeBindings({ env, stateDir: params.stateDir });
  const controller = createGovernorControllerIfEnabled({
    ...params,
    env,
    hostBindings: {
      receiptResolver: bindings.resolver,
      approvalResolver: bindings.approvalResolver,
      deliveryResolver: bindings.deliveryResolver,
    },
  });
  return controller ? new GovernorRuntimeAdapter(controller) : null;
}
