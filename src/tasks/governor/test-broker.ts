// Synthetic host bootstrap for governor tests only. Never import from runtime code.
import { createHostGovernorBroker } from "../../security/governor-host-broker.js";
import { GovernorSqliteStore } from "./store.js";

export function createGovernorTestBroker() {
  return createHostGovernorBroker({ receiptSigningKey: "synthetic-governor-test-receipt-key" });
}

export function createGovernorTestStore(params: { stateDir?: string } = {}) {
  const broker = createGovernorTestBroker();
  return {
    broker,
    store: new GovernorSqliteStore({
      ...params,
      receiptResolver: broker.resolver,
      approvalResolver: broker.approvalResolver,
      deliveryResolver: broker.deliveryResolver,
      testReceiptCapabilities: broker.capabilities,
    }),
  };
}
