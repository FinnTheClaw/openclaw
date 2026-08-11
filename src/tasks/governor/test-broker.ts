// Synthetic host bootstrap for governor tests only. Never import from runtime code.
import { createHostGovernorBroker } from "../../security/governor-host-broker.js";

export function createGovernorTestBroker() {
  return createHostGovernorBroker({ receiptSigningKey: "synthetic-governor-test-receipt-key" });
}
