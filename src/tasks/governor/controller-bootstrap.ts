import type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedMemoryAuthority,
  GovernorTrustedPhysicalExecutionCoordinator,
  GovernorTrustedReceiptResolver,
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedTaskAuthority,
} from "../../security/governor-host-readonly.js";
import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { GovernorController } from "./controller.js";
// Feature-gated host construction stays separate from task-loop operations.
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import { assertSafeGovernorPolicyBundle } from "./policy-lint.js";
import {
  GOVERNOR_POLICY_DIGEST,
  GOVERNOR_POLICY_ID,
  GOVERNOR_POLICY_RULE_IDS,
  GOVERNOR_POLICY_RULES,
  GOVERNOR_POLICY_SEMANTICS,
  GOVERNOR_POLICY_VERSION,
} from "./policy.js";
import { GovernorSqliteStore, type GovernorStoreSecrets } from "./store.js";

export function createGovernorControllerIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
  hostBindings?: {
    receiptResolver: GovernorTrustedReceiptResolver;
    evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
    approvalResolver: GovernorTrustedApprovalResolver;
    deliveryResolver: GovernorTrustedDeliveryResolver;
    ownerIngressResolver: GovernorTrustedOwnerIngressResolver;
    physicalExecutionCoordinator: GovernorTrustedPhysicalExecutionCoordinator;
    memoryAuthority: GovernorTrustedMemoryAuthority;
    taskAuthority: GovernorTrustedTaskAuthority;
    secrets: GovernorStoreSecrets;
    stateEnv: NodeJS.ProcessEnv;
  };
}): GovernorController | null {
  const env = params.env ?? {};
  if (params.enabled !== true && !isBehaviorGovernorEnabled(env)) {
    return null;
  }
  if (!params.hostBindings) {
    throw new Error(
      "Governor host runtime bindings are required when the behavior governor is enabled",
    );
  }
  assertSafeGovernorPolicyBundle({
    policyId: GOVERNOR_POLICY_ID,
    version: GOVERNOR_POLICY_VERSION,
    digest: GOVERNOR_POLICY_DIGEST,
    ruleIds: GOVERNOR_POLICY_RULE_IDS,
    rules: GOVERNOR_POLICY_RULES,
    semantics: GOVERNOR_POLICY_SEMANTICS,
  });
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
