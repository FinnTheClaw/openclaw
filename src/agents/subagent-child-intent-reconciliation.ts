import type { SubagentChildIntentReservation } from "./subagent-child-intent-registry.js";

export type ChildIntentReconciliation = "duplicate" | "retry" | "adopt";

function isProviderPresent(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const value = response as { status?: unknown; providerStarted?: unknown };
  return (
    value.providerStarted === true ||
    (typeof value.status === "string" && value.status !== "timeout")
  );
}

/**
 * Reconciles a durable dispatching/unknown row without ever retrying an
 * ambiguous provider outcome. Only the durable receipt's not_accepted state
 * authorizes a new attempt; an agent.wait response is never proof after a
 * gateway restart because that lookup is not an authoritative receipt.
 */
export async function reconcileSubagentChildIntent(params: {
  reservation: SubagentChildIntentReservation;
  waitForProvider: () => Promise<unknown>;
  lookupAcceptance: () =>
    | {
        lifecycle:
          | "preaccepted"
          | "runnable"
          | "dispatch_claimed"
          | "accepted"
          | "start_authorized"
          | "started"
          | "failed_before_start"
          | "failed_after_start"
          | "unknown"
          | "not_accepted"
          | "cancel_requested"
          | "cancelled"
          | "terminal";
        gatewayRunId?: string;
      }
    | undefined;
  adopt: () => boolean;
  abandon: () => boolean;
}): Promise<ChildIntentReconciliation> {
  if (!params.reservation.dispatchState || !params.reservation.reservationToken) {
    return "duplicate";
  }
  const receipt = params.lookupAcceptance();
  if (
    receipt &&
    [
      "runnable",
      "dispatch_claimed",
      "accepted",
      "start_authorized",
      "started",
      "terminal",
    ].includes(receipt.lifecycle)
  ) {
    // The durable gateway receipt, not the reservation placeholder, owns the
    // provider identity. This also covers a controller crash after the
    // gateway accepted the run but before the child row was updated.
    if (receipt.gatewayRunId) {
      params.reservation.existingRunId = receipt.gatewayRunId;
    }
    return params.adopt() ? "adopt" : "duplicate";
  }
  if (receipt?.lifecycle === "not_accepted" || receipt?.lifecycle === "failed_before_start") {
    return params.abandon() ? "retry" : "duplicate";
  }
  if (receipt?.lifecycle !== undefined) {
    // preaccepted, failed_after_start, and cancellation/unknown states are
    // durable fences. They require host reconciliation and cannot be retried.
    return "duplicate";
  }
  if (params.reservation.durableReceiptRequired !== true) {
    if (!receipt) {
      // Legacy test/in-process adapters do not expose the durable receipt
      // seam; retain their provider-presence behavior. Real persisted rows
      // always set durableReceiptRequired and remain fenced when absent.
      const legacyResponse = await params.waitForProvider();
      return isProviderPresent(legacyResponse) && params.adopt() ? "adopt" : "duplicate";
    }
  }
  // A missing or unavailable durable receipt is ambiguous after a gateway
  // restart. The callback may have failed before returning, so no provider
  // wait result can prove that an accepted request did not exist.
  return "duplicate";
}
