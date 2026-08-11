import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getSyntheticHostObservableSends,
  resetSyntheticHostDeliveryAttempts,
} from "./governor-host-delivery-implementations.js";
import { createGovernorTestHostBindings } from "./governor-host-readonly.js";

afterEach(() => {
  closeOpenClawStateDatabase();
  resetSyntheticHostDeliveryAttempts("test");
});

describe("governor unknown delivery review", () => {
  it("never resends an unknown effect and permits audited retirement before rotation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-delivery-review-" },
      async (state) => {
        const config = { observerKey: "review-observer", throwDeliveryKey: "unknown-key" };
        const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const handle = first.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config,
          generation: 0,
        });
        const adapter = first.deliveryResolver.resolve(handle);
        if (!adapter) {
          throw new Error("expected certified synthetic adapter");
        }
        const payload = { safe: "payload" };
        await expect(adapter.send({ deliveryKey: "unknown-key", payload })).rejects.toThrow(
          /interrupted before observable send/,
        );
        expect(getSyntheticHostObservableSends("test", "review-observer")).toEqual([]);
        expect(() => first.capabilities.revokeDeliveryAdapter({ handle })).toThrow(
          /not durably applied/,
        );

        closeOpenClawStateDatabase();
        const restarted = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const reconstructedHandle = restarted.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config,
          generation: 0,
        });
        expect(reconstructedHandle).toBe(handle);
        const reconstructed = restarted.deliveryResolver.resolve(handle);
        if (!reconstructed) {
          throw new Error("expected recovery-limited exact adapter reconstruction");
        }
        expect(
          await reconstructed.send({ deliveryKey: "safe-key", payload: { safe: "unrelated" } }),
        ).toMatchObject({ status: "sent" });
        expect(getSyntheticHostObservableSends("test", "review-observer")).toEqual(["safe-key"]);
        expect(
          restarted.capabilities.resolveUnknownDelivery({
            handle,
            deliveryKey: "unknown-key",
            payloadDigest: governorDigest({ wrong: true }),
            resolution: "retired_unknown",
          }),
        ).toBe(false);
        const resolution = {
          handle,
          deliveryKey: "unknown-key",
          payloadDigest: governorDigest(payload),
          resolution: "retired_unknown" as const,
        };
        expect(restarted.capabilities.resolveUnknownDelivery(resolution)).toBe(true);
        expect(restarted.capabilities.resolveUnknownDelivery(resolution)).toBe(true);
        expect(await reconstructed.send({ deliveryKey: "unknown-key", payload })).toMatchObject({
          status: "unknown",
        });
        expect(getSyntheticHostObservableSends("test", "review-observer")).toEqual(["safe-key"]);
        expect(restarted.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
        expect(restarted.deliveryResolver.resolve(handle)).toBeNull();
      },
    );
  });

  it.each(["confirmed_not_sent", "confirmed_sent"] as const)(
    "supports idempotent %s resolution without a blind resend",
    async (resolution) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `governor-delivery-${resolution}-` },
        async (state) => {
          const observerKey = `review-${resolution}`;
          const payload = { safe: resolution };
          const config = { observerKey, throwDeliveryKey: "ambiguous-key" };
          const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
          const handle = first.capabilities.registerStaticDeliveryAdapter({
            implementationId: "synthetic",
            config,
            generation: 0,
          });
          const adapter = first.deliveryResolver.resolve(handle);
          if (!adapter) {
            throw new Error("expected ambiguous delivery adapter");
          }
          await expect(adapter.send({ deliveryKey: "ambiguous-key", payload })).rejects.toThrow();

          closeOpenClawStateDatabase();
          const restarted = createGovernorTestHostBindings({ stateDir: state.stateDir });
          expect(
            restarted.capabilities.registerStaticDeliveryAdapter({
              implementationId: "synthetic",
              config,
              generation: 0,
            }),
          ).toBe(handle);
          const exact = {
            handle,
            deliveryKey: "ambiguous-key",
            payloadDigest: governorDigest(payload),
            resolution,
          };
          expect(restarted.capabilities.resolveUnknownDelivery(exact)).toBe(true);
          expect(restarted.capabilities.resolveUnknownDelivery(exact)).toBe(true);
          const recovered = restarted.deliveryResolver.resolve(handle);
          if (!recovered) {
            throw new Error("expected resolution recovery adapter");
          }
          expect(await recovered.send({ deliveryKey: "ambiguous-key", payload })).toMatchObject({
            status: "unknown",
          });
          expect(getSyntheticHostObservableSends("test", observerKey)).toEqual([]);
          expect(restarted.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
        },
      );
    },
  );
});
