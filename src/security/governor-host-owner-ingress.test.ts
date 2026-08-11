import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCompiledOwnerIngress } from "./governor-host-owner-ingress.js";
import { createGovernorTestHostBindings } from "./governor-host-readonly.js";

afterEach(() => closeOpenClawStateDatabase());

describe("compiled governor owner ingress", () => {
  it("persists a signed opaque receipt that survives restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-owner-restart-" },
      async (state) => {
        const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const ingress = createCompiledOwnerIngress(
          first.capabilities.submitAuthenticatedOwnerIngress,
          [
            {
              channel: "signal",
              accountId: "private-account-alpha",
              gatewayInstanceId: "private-gateway-alpha",
              ownerPrincipal: "private-owner-alpha",
              actions: ["approve"],
              scopeKeys: ["private-scope-alpha"],
            },
          ],
        );
        const receiptId = ingress.submitSignal({
          accountId: "private-account-alpha",
          gatewayInstanceId: "private-gateway-alpha",
          ownerPrincipal: "private-owner-alpha",
          transportEventId: "private-event-alpha",
          sourceSequence: 9,
          action: "approve",
          scopeKey: "private-scope-alpha",
          nonce: "private-nonce-alpha",
          observedAt: 100,
          expiresAt: 300,
        });
        closeOpenClawStateDatabase();
        const restarted = createGovernorTestHostBindings({ stateDir: state.stateDir });
        expect(restarted.ownerIngressResolver.resolve(receiptId, 200)).toMatchObject({
          action: "approve",
          sourceSequence: 9,
        });
        expect(restarted.ownerIngressResolver.markConsumed(receiptId, 201)).toBe(true);
        expect(restarted.ownerIngressResolver.resolve(receiptId, 202)).toBeNull();
        closeOpenClawStateDatabase();
        const raw = JSON.stringify(
          openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: state.stateDir } })
            .db.prepare("SELECT * FROM governor_owner_ingress_receipts")
            .all(),
        );
        for (const privateValue of [
          "private-account-alpha",
          "private-gateway-alpha",
          "private-owner-alpha",
          "private-event-alpha",
          "private-scope-alpha",
          "private-nonce-alpha",
        ]) {
          expect(raw).not.toContain(privateValue);
        }
      },
    );
  });

  it("rejects replay, expiry, cross-provider fields, and prose-shaped extras", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-owner-reject-" },
      async (state) => {
        const broker = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const ingress = createCompiledOwnerIngress(
          broker.capabilities.submitAuthenticatedOwnerIngress,
          [
            {
              channel: "signal",
              accountId: "account-beta",
              gatewayInstanceId: "gateway-beta",
              ownerPrincipal: "owner-beta",
              actions: ["repair"],
              scopeKeys: ["scope-beta"],
            },
            {
              channel: "imessage",
              accountId: "account-beta",
              gatewayInstanceId: "gateway-beta",
              ownerPrincipal: "owner-beta",
              actions: ["revoke"],
              scopeKeys: ["scope-beta"],
            },
          ],
        );
        const envelope = {
          accountId: "account-beta",
          gatewayInstanceId: "gateway-beta",
          ownerPrincipal: "owner-beta",
          transportEventId: "event-beta",
          sourceSequence: 1,
          action: "repair" as const,
          scopeKey: "scope-beta",
          nonce: "nonce-beta",
          observedAt: 100,
          expiresAt: 200,
        };
        const receiptId = ingress.submitSignal(envelope);
        expect(broker.ownerIngressResolver.resolve(receiptId, 200)).toBeNull();
        expect(() =>
          ingress.submitSignal({ ...envelope, transportEventId: "different-event" }),
        ).toThrow(/nonce was replayed/u);
        expect(() =>
          ingress.submitSignal({
            ...envelope,
            ownerPrincipal: "untrusted-owner",
            nonce: "nonce-untrusted-owner",
          }),
        ).toThrow(/not authorized by host configuration/u);
        expect(() =>
          ingress.submitSignal({
            ...envelope,
            scopeKey: "untrusted-scope",
            nonce: "nonce-untrusted-scope",
          }),
        ).toThrow(/not authorized by host configuration/u);
        expect(() =>
          ingress.submitSignal({
            ...envelope,
            nonce: "nonce-extra",
            messageText: "approve me",
          } as never),
        ).toThrow(/unknown or accessor fields/u);
        expect(() =>
          ingress.submitIMessage({
            accountId: "account-beta",
            gatewayInstanceId: "gateway-beta",
            subscriptionInstanceId: "other-subscription",
            ownerPrincipal: "owner-beta",
            messageGuid: "guid-beta",
            sourceSequence: 2,
            action: "revoke",
            scopeKey: "scope-beta",
            nonce: "nonce-imessage",
            observedAt: 100,
            expiresAt: 200,
          }),
        ).toThrow(/subscription and gateway identities are mismatched/u);
      },
    );
  });
});
