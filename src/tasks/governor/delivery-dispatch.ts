// Dispatches a claimed reply only through a host-certified delivery adapter.
import type { HostGovernorDeliveryHandle } from "../../security/governor-host-broker.js";
import type { GovernorOutboxClaimResult } from "./outbox-store.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskId } from "./types.js";

export type GovernorDispatchOutboxParams = {
  taskId: GovernorTaskId;
  effectId: string;
  expectedLeaseEpoch: number;
  workerId: string;
  leaseDurationMs?: number;
  adapterHandle: HostGovernorDeliveryHandle;
  now: number;
};

export async function dispatchGovernorOutbox(params: {
  store: GovernorSqliteStore;
  adapterHandle: HostGovernorDeliveryHandle;
  request: GovernorDispatchOutboxParams;
}): Promise<GovernorOutboxClaimResult> {
  const { request } = params;
  const adapter = params.store.resolveCertifiedDelivery(params.adapterHandle);
  const claim = params.store.outbox.claim(request);
  if (claim.kind !== "claimed") {
    return claim;
  }
  const delivery = await adapter.send({
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
