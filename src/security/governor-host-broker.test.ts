import { describe, expect, it } from "vitest";
import {
  createHostGovernorBroker,
  isTrustedGovernorReceiptResolver,
} from "./governor-host-broker.js";

describe("governor host broker", () => {
  it("keeps receipt creation capability separate from a scope-bound resolver", () => {
    const broker = createHostGovernorBroker({ receiptSigningKey: "synthetic-test-key" });
    const receiptId = broker.capabilities.submitObservedReceipt({
      scopeKey: "scope-a",
      sourceKind: "tool",
      sourceIdentity: "synthetic-tool",
      payload: { result: "ok" },
      observedAt: 100,
    });

    expect(broker.resolver.resolve(receiptId, "scope-a")?.payload).toEqual({ result: "ok" });
    expect(broker.resolver.resolve(receiptId, "scope-b")).toBeNull();
    expect(isTrustedGovernorReceiptResolver(broker.resolver)).toBe(true);
    expect(isTrustedGovernorReceiptResolver({ resolve: () => null })).toBe(false);
  });
});
