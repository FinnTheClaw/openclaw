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
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedApprovalResolver,
  type GovernorTrustedDeliveryResolver,
  type GovernorTrustedReceiptResolver,
  type HostGovernorApprovalReceiptId,
  type HostGovernorApprovalRevocationId,
  type HostGovernorCapabilities,
  type HostGovernorDeliveryHandle,
  type HostGovernorReceiptId,
} from "./governor-host-broker.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";

export {
  isTrustedGovernorApprovalResolver,
  isTrustedGovernorDeliveryResolver,
  isTrustedGovernorReceiptResolver,
};
export type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedReceiptResolver,
  HostGovernorApprovalReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorReceiptId,
};

export function createGovernorTestHostBindings(params: { stateDir?: string } = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Governor test host bindings are unavailable outside tests");
  }
  return createHostGovernorBroker({
    receiptSigningKey: "synthetic-governor-test-receipt-key",
    persistence: createGovernorHostPersistence(params),
  });
}
