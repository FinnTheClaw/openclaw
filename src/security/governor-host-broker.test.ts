import { describe, expect, it } from "vitest";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { isTrustedGovernorReceiptResolver } from "./governor-host-broker.js";
import { createHostDeliveryImplementation } from "./governor-host-delivery-implementations.js";
import { createGovernorTestHostBindings } from "./governor-host-readonly.js";

describe("governor host broker", () => {
  it("keeps receipt creation capability separate from a scope-bound resolver", () => {
    const broker = createGovernorTestHostBindings();
    const receiptId = broker.capabilities.submitObservedReceipt({
      scopeKey: "scope-a",
      taskId: "task-a",
      taskVersion: 1,
      objectiveRevision: 1,
      planVersion: 1,
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

  it("resolves only a compiled implementation and snapshots caller-owned config", async () => {
    const broker = createGovernorTestHostBindings();
    const originalConfig = { label: "before", nested: { value: "before" } };
    const registration = {
      implementationId: "synthetic",
      config: originalConfig,
      generation: 0,
    };
    const handle = broker.capabilities.registerStaticDeliveryAdapter(registration);
    registration.config = { label: "caller-replaced", nested: { value: "caller-replaced" } };
    originalConfig.label = "after";
    originalConfig.nested.value = "after";

    const resolved = broker.deliveryResolver.resolve(handle);
    expect(resolved).not.toBeNull();
    const result = await resolved!.send({ deliveryKey: "key", payload: {} });
    expect(result.status).toBe("sent");
    expect(resolved!.configDigest).toBe(
      governorDigest({ label: "before", nested: { value: "before" } }),
    );
    if (result.status !== "sent") {
      throw new Error("expected signed host delivery receipt");
    }
    expect(broker.deliveryResolver.verifyReceipt(result.receipt)).toBe(true);
    expect(result.receipt.providerReceiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    for (const tampered of [
      { ...result.receipt, deliveryKey: "different-key" },
      { ...result.receipt, payloadDigest: "0".repeat(64) },
      { ...result.receipt, outcome: "would_send" as const },
    ]) {
      expect(broker.deliveryResolver.verifyReceipt(tampered)).toBe(false);
    }
  });

  it("persists authenticated owner ingress without raw channel identities", () => {
    const broker = createGovernorTestHostBindings();
    const id = broker.capabilities.submitAuthenticatedOwnerIngress({
      channel: "signal",
      accountId: "private-account-fixture",
      gatewayInstanceId: "private-gateway-fixture",
      ownerPrincipal: "private-owner-fixture",
      sourceMessageId: "private-message-fixture",
      sourceSequence: 7,
      action: "repair",
      scopeKey: "private-scope-fixture",
      nonce: "private-nonce-fixture",
      observedAt: 100,
      expiresAt: 200,
    });
    const receipt = broker.ownerIngressResolver.resolve(id, 150);
    expect(receipt).toMatchObject({ channel: "signal", action: "repair", sourceSequence: 7 });
    const serialized = JSON.stringify(receipt);
    for (const raw of [
      "private-account-fixture",
      "private-gateway-fixture",
      "private-owner-fixture",
      "private-message-fixture",
      "private-scope-fixture",
      "private-nonce-fixture",
    ]) {
      expect(serialized).not.toContain(raw);
    }
    expect(broker.ownerIngressResolver.resolve(id, 201)).toBeNull();
  });

  it("rejects arbitrary IDs, caller functions, registries, and executable config fields", () => {
    const broker = createGovernorTestHostBindings();
    expect(() =>
      broker.capabilities.registerStaticDeliveryAdapter({
        implementationId: "caller-owned",
        config: {},
        generation: 0,
      }),
    ).toThrow(/not allowlisted/);

    let closureState = "before";
    let functionVariable = () => closureState;
    expect(() =>
      broker.capabilities.registerStaticDeliveryAdapter({
        implementationId: "synthetic",
        config: { send: functionVariable } as never,
        generation: 0,
      }),
    ).toThrow(/executable|non-JSON/);
    functionVariable = () => "after";
    closureState = "after";

    expect(() =>
      broker.capabilities.registerStaticDeliveryAdapter({
        implementationId: "synthetic",
        config: { nested: { factory: "caller-owned" } } as never,
        generation: 0,
      }),
    ).toThrow(/executable/);
    expect(() =>
      broker.capabilities.registerStaticDeliveryAdapter({
        implementationId: "synthetic",
        config: {},
        generation: 0,
        send: functionVariable,
      } as never),
    ).toThrow(/only implementationId, config, and generation/);
  });

  it("rejects the synthetic implementation without the trusted test mode", () => {
    expect(() =>
      createHostDeliveryImplementation({
        implementationId: "synthetic",
        config: {},
        mode: "production",
      }),
    ).toThrow(/test-only/);
  });

  it("uses explicit test mode without reading ambient process environment", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(
        createHostDeliveryImplementation({
          implementationId: "synthetic",
          config: {},
          mode: "test",
        }).identity,
      ).toEqual({ adapterId: "synthetic", version: "1", capability: "message.send" });
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});
