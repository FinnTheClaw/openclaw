import { expect, it, type Mock } from "vitest";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams, makeResolvedDelivery } from "./delivery-dispatch.test-fixtures.js";
import type { waitForDescendantSubagentResult } from "./subagent-followup.runtime.js";

/** Registers the current-target handoff matrix with the parent suite's isolated mocks. */
export function registerCurrentTargetHandoffTests({
  childResult,
  childFallback,
  commitBackgroundResultToSessionMock,
  deliverOutboundPayloads,
  expectDeliveryCall,
}: {
  childResult: Mock<typeof waitForDescendantSubagentResult>;
  childFallback: unknown;
  commitBackgroundResultToSessionMock: unknown;
  deliverOutboundPayloads: unknown;
  expectDeliveryCall: (callIndex: number, expected: Record<string, unknown>) => void;
}) {
  it("commits a settled child reply to the current session without an outbound route", async () => {
    const reply = "Final child result.";
    childResult.mockResolvedValue({ disposition: "visible", reply });
    const params = makeBaseParams({
      synthesizedText: "",
      sessionTarget: "current",
      spawnOnlyHandoff: true,
      runStartedAt: 1_000,
    });
    params.resolvedDelivery = {
      ok: false,
      channel: "webchat",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      error: new Error("webchat has no outbound adapter"),
    };

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    expect(childResult).toHaveBeenCalledOnce();
    expect(childFallback).not.toHaveBeenCalled();
    expect(commitBackgroundResultToSessionMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey: params.sourceSessionKey, text: reply }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("sends a settled child reply through the current-target outbound route only", async () => {
    const reply = "Final child result.";
    childResult.mockResolvedValue({ disposition: "visible", reply });
    const destination = makeResolvedDelivery();
    const params = makeBaseParams({
      synthesizedText: "",
      sessionTarget: "current",
      spawnOnlyHandoff: true,
    });
    params.resolvedDelivery = destination;

    const state = await dispatchCronDelivery(params);

    expect(state).toMatchObject({ delivered: true, deliveryAttempted: true });
    expect(childResult).toHaveBeenCalledOnce();
    expect(childFallback).not.toHaveBeenCalled();
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
    expectDeliveryCall(0, {
      transcriptRoute: destination.sessionRoute,
      payloads: [{ text: reply }],
    });
  });
}
