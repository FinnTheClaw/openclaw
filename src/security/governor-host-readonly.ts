/**
 * Read-only governor host contracts.
 *
 * Governor/task code may depend on these resolver shapes, but never on the
 * capability kernel.  The only runtime factory here is deliberately test-only
 * and rejects every non-test process.
 */
import {
  createHostGovernorBroker,
  isTrustedGovernorApprovalResolver,
  isTrustedGovernorDeliveryResolver,
  isTrustedGovernorOwnerIngressResolver,
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedApprovalResolver,
  type GovernorTrustedDeliveryResolver,
  type GovernorTrustedOwnerIngressResolver,
  type GovernorTrustedReceiptResolver,
  type GovernorOwnerIngressClaim,
  type HostGovernorApprovalReceiptId,
  type HostGovernorApprovalRevocationId,
  type HostGovernorCapabilities,
  type HostGovernorDeliveryHandle,
  type HostGovernorOwnerIngressReceiptId,
  type HostGovernorOwnerIngressClaimToken,
  type HostGovernorReceiptId,
  type HostDeliveryReceipt,
} from "./governor-host-broker.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import {
  isTrustedGovernorPhysicalExecutionCoordinator,
  type GovernorPhysicalExecutionBinding,
  type GovernorPhysicalExecutionLease,
  type GovernorPhysicalExecutionState,
  type GovernorTrustedPhysicalExecutionCoordinator,
} from "./governor-host-physical-execution.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "./governor-host-secrets.js";

export {
  isTrustedGovernorApprovalResolver,
  isTrustedGovernorDeliveryResolver,
  isTrustedGovernorOwnerIngressResolver,
  isTrustedGovernorPhysicalExecutionCoordinator,
  isTrustedGovernorReceiptResolver,
};
export type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorPhysicalExecutionBinding,
  GovernorPhysicalExecutionLease,
  GovernorPhysicalExecutionState,
  GovernorTrustedPhysicalExecutionCoordinator,
  GovernorTrustedReceiptResolver,
  GovernorOwnerIngressClaim,
  HostGovernorApprovalReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorOwnerIngressReceiptId,
  HostGovernorOwnerIngressClaimToken,
  HostGovernorReceiptId,
  HostDeliveryReceipt,
};

export function createGovernorTestHostBindings(params: { stateDir?: string } = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Governor test host bindings are unavailable outside tests");
  }
  const env = syntheticGovernorSecretsEnvironment(params.stateDir);
  const secrets = resolveGovernorSecrets(env);
  const broker = createHostGovernorBroker({
    secrets,
    persistence: createGovernorHostPersistence({
      env,
      ...params,
      secrets,
      testMode: true,
    }),
  });
  return { ...broker, secrets };
}
