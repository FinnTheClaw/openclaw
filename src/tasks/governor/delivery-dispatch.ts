// Dispatches a claimed reply only through a host-certified delivery adapter.
import type { GovernorRegisteredDeliveryAdapter } from "./delivery-certification.js";
import type { GovernorOutboxClaimResult } from "./outbox-store.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskId } from "./types.js";

export type GovernorDispatchOutboxParams = {
  taskId: GovernorTaskId;
  effectId: string;
  expectedLeaseEpoch: number;
  workerId: string;
  leaseDurationMs?: number;
  adapterHandle: string;
  now: number;
};

export async function dispatchGovernorOutbox(params: {
  store: GovernorSqliteStore;
  adapter: GovernorRegisteredDeliveryAdapter;
  request: GovernorDispatchOutboxParams;
}): Promise<GovernorOutboxClaimResult> {
  const { request } = params;
  params.store.deliveryCertifications.assertCertified(params.adapter);
  const claim = params.store.outbox.claim(request);
  if (claim.kind !== "claimed") {
    return claim;
  }
  const delivery = await params.adapter.adapter.send({
    deliveryKey: claim.entry.deliveryKey,
    payload: claim.entry.payload,
  });
  if (delivery.deliveryKey !== claim.entry.deliveryKey) {
    throw new Error("Governor delivery provider returned a mismatched delivery key");
  }
  return params.store.outbox.markSent({
    taskId: request.taskId,
    effectId: request.effectId,
    expectedLeaseEpoch: request.expectedLeaseEpoch,
    expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
    workerId: request.workerId,
    providerReceipt: delivery.receipt,
    now: request.now + 1,
  });
}
