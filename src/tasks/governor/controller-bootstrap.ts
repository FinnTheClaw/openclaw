import type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedReceiptResolver,
} from "../../security/governor-host-readonly.js";
import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { GovernorController } from "./controller.js";
// Feature-gated host construction stays separate from task-loop operations.
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import { GovernorSqliteStore } from "./store.js";
import { assertGovernorIdentityHmacKeyAvailable } from "./types.js";

export function createGovernorControllerIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  hostBindings?: {
    receiptResolver: GovernorTrustedReceiptResolver;
    approvalResolver: GovernorTrustedApprovalResolver;
    deliveryResolver: GovernorTrustedDeliveryResolver;
  };
}): GovernorController | null {
  if (!isBehaviorGovernorEnabled(params.env)) {
    return null;
  }
  const env = { ...process.env, ...params.env };
  assertGovernorIdentityHmacKeyAvailable(env);
  if (!params.hostBindings) {
    throw new Error(
      "Governor host runtime bindings are required when the behavior governor is enabled",
    );
  }
  return new GovernorController(
    new GovernorSqliteStore({ stateDir: params.stateDir, ...params.hostBindings }),
    new GovernorCapabilityRegistry(params.capabilities),
  );
}
