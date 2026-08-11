import type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedReceiptResolver,
} from "../../security/governor-host-readonly.js";
import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { GovernorController } from "./controller.js";
// Feature-gated host construction stays separate from task-loop operations.
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import { GovernorSqliteStore, type GovernorStoreSecrets } from "./store.js";

export function createGovernorControllerIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  hostBindings?: {
    receiptResolver: GovernorTrustedReceiptResolver;
    approvalResolver: GovernorTrustedApprovalResolver;
    deliveryResolver: GovernorTrustedDeliveryResolver;
    ownerIngressResolver: GovernorTrustedOwnerIngressResolver;
    secrets: GovernorStoreSecrets;
    stateEnv: NodeJS.ProcessEnv;
  };
}): GovernorController | null {
  const env = params.env ?? {};
  if (!isBehaviorGovernorEnabled(env)) {
    return null;
  }
  if (!params.hostBindings) {
    throw new Error(
      "Governor host runtime bindings are required when the behavior governor is enabled",
    );
  }
  const capabilities = new GovernorCapabilityRegistry(params.capabilities);
  return new GovernorController(
    new GovernorSqliteStore({
      stateDir: params.stateDir,
      ...params.hostBindings,
      stateEnv: env,
      capabilities,
    }),
    capabilities,
  );
}
