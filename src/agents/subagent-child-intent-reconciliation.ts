import type { SubagentChildIntentReservation } from "./subagent-child-intent-registry.js";

export type ChildIntentReconciliation = "duplicate" | "retry" | "adopt";

function isProvenNotAccepted(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const value = response as {
    status?: unknown;
    providerStarted?: unknown;
    timeoutPhase?: unknown;
  };
  return (
    value.status === "timeout" && value.providerStarted === false && value.timeoutPhase === "queue"
  );
}

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
 * ambiguous provider outcome. A queue timeout is the only proof that a new
 * dispatch is safe; every other observed provider state is adopted.
 */
export async function reconcileSubagentChildIntent(params: {
  reservation: SubagentChildIntentReservation;
  waitForProvider: () => Promise<unknown>;
  lookupAcceptance: () => { lifecycle: "accepted" | "not_accepted" | "cancelled" } | undefined;
  adopt: () => boolean;
  abandon: () => boolean;
}): Promise<ChildIntentReconciliation> {
  if (!params.reservation.dispatchState || !params.reservation.reservationToken) {
    return "duplicate";
  }
  const receipt = params.lookupAcceptance();
  if (receipt?.lifecycle === "accepted") {
    return params.adopt() ? "adopt" : "duplicate";
  }
  if (receipt?.lifecycle !== "not_accepted") {
    if (!receipt && params.reservation.durableReceiptRequired !== true) {
      // Legacy test/in-process adapters do not expose the durable receipt
      // seam; retain their provider-presence behavior. Real persisted rows
      // always set durableReceiptRequired and remain fenced when absent.
      const legacyResponse = await params.waitForProvider();
      return isProviderPresent(legacyResponse) && params.adopt() ? "adopt" : "duplicate";
    }
    // A missing or unavailable receipt is ambiguous after a gateway restart.
    // agent.wait cannot prove that an accepted request did not exist.
    return "duplicate";
  }
  let response: unknown;
  try {
    response = await params.waitForProvider();
  } catch {
    return "duplicate";
  }
  if (isProvenNotAccepted(response)) {
    return params.abandon() ? "retry" : "duplicate";
  }
  if (isProviderPresent(response) && params.adopt()) {
    return "adopt";
  }
  return "duplicate";
}
