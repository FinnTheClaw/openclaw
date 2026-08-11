import { describe, expect, it } from "vitest";
import { assertGovernorMandatoryEvalGates, summarizeGovernorEvals } from "./eval-harness.js";
import {
  BrokenDeliveryAdapter,
  BrokenMutationAdapter,
  countGovernorObservedKey,
} from "./mandatory-eval-adapters.js";

describe("behavior governor mandatory observable-effect gate", () => {
  it("rejects duplicate externally observable mutation and delivery effects", () => {
    const mutation = new BrokenMutationAdapter();
    const delivery = new BrokenDeliveryAdapter();
    mutation.apply("stable-mutation-key");
    mutation.apply("stable-mutation-key");
    void delivery.send({ deliveryKey: "stable-delivery-key", payload: {} });
    void delivery.send({ deliveryKey: "stable-delivery-key", payload: {} });
    const summary = summarizeGovernorEvals([
      {
        success: true,
        prematureCompletion: false,
        resumedAfterCrash: true,
        duplicateMutation:
          countGovernorObservedKey(mutation.observableEffects, "stable-mutation-key") > 1,
        duplicateReply:
          countGovernorObservedKey(delivery.observableSends, "stable-delivery-key") > 1,
        meaningfulCalls: mutation.attempts.length + delivery.attempts.length,
        usefulCalls: 2,
      },
    ]);
    expect(() =>
      assertGovernorMandatoryEvalGates({
        summary,
        accessInventory: summarizeGovernorEvals([
          {
            success: true,
            prematureCompletion: false,
            resumedAfterCrash: true,
            duplicateMutation: false,
            duplicateReply: false,
            meaningfulCalls: 1,
            usefulCalls: 1,
          },
        ]),
        baselineShortTaskSuccessRate: 1,
      }),
    ).toThrow(/duplicate_mutation.*duplicate_reply/u);
  });
});
