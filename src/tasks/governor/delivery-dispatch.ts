// Dispatches a claimed reply only through a host-certified delivery adapter.
import type { HostGovernorDeliveryHandle } from "../../security/governor-host-readonly.js";
import type { HostDeliveryReceipt } from "../../security/governor-host-readonly.js";
import { governorDigest } from "./canonical-json.js";
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

function receiptMatchesClaim(params: {
  receipt: HostDeliveryReceipt;
  deliveryKey: string;
  payloadDigest: string;
}): boolean {
  return (
    params.receipt.deliveryKey === params.deliveryKey &&
    params.receipt.payloadDigest === params.payloadDigest
  );
}

function dispatchReason(reason: string): string {
  return governorDigest({ reason });
}

export async function dispatchGovernorOutbox(params: {
  store: GovernorSqliteStore;
  adapterHandle: HostGovernorDeliveryHandle;
  request: GovernorDispatchOutboxParams;
}): Promise<GovernorOutboxClaimResult> {
  const { request } = params;
  const adapter = params.store.resolveCertifiedDelivery(params.adapterHandle);
  const deliveryBinding = {
    adapterHandle: adapter.handle,
    identityKey: adapter.identityKey,
    implementationDigest: adapter.implementationDigest,
    configDigest: adapter.configDigest,
    generation: adapter.generation,
    channel: adapter.binding.channel,
    accountIdentity: adapter.binding.accountIdentity,
    targetIdentity: adapter.binding.targetIdentity,
    deploymentIdentity: adapter.binding.deploymentIdentity,
  };
  const claim = params.store.outbox.claim({ ...request, deliveryBinding });
  if (claim.kind === "reconcile_required") {
    const payloadDigest =
      claim.entry.providerReceipt &&
      !Array.isArray(claim.entry.providerReceipt) &&
      typeof claim.entry.providerReceipt === "object" &&
      typeof claim.entry.providerReceipt.payloadDigest === "string"
        ? claim.entry.providerReceipt.payloadDigest
        : undefined;
    if (!payloadDigest) {
      return params.store.outbox.markManualReview({
        taskId: request.taskId,
        effectId: request.effectId,
        expectedLeaseEpoch: request.expectedLeaseEpoch,
        expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
        reasonDigest: dispatchReason("missing_payload_digest"),
        now: request.now,
      });
    }
    const reconciliation = await adapter.reconcile({
      deliveryKey: claim.entry.deliveryKey,
      payloadDigest,
    });
    if (
      reconciliation.status === "sent" &&
      receiptMatchesClaim({
        receipt: reconciliation.receipt,
        deliveryKey: claim.entry.deliveryKey,
        payloadDigest,
      })
    ) {
      const verifiedReceipt = params.store.verifyCertifiedDeliveryReceipt(reconciliation.receipt);
      if (!verifiedReceipt) {
        return params.store.outbox.markManualReview({
          taskId: request.taskId,
          effectId: request.effectId,
          expectedLeaseEpoch: request.expectedLeaseEpoch,
          expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
          reasonDigest: dispatchReason("invalid_reconciled_delivery_receipt"),
          now: request.now,
        });
      }
      return params.store.outbox.markSent({
        taskId: request.taskId,
        effectId: request.effectId,
        expectedLeaseEpoch: request.expectedLeaseEpoch,
        expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
        workerId: claim.entry.claimedBy ?? request.workerId,
        verifiedReceipt,
        now: request.now,
      });
    }
    return params.store.outbox.markManualReview({
      taskId: request.taskId,
      effectId: request.effectId,
      expectedLeaseEpoch: request.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
      reasonDigest: dispatchReason("authoritative_reconciliation_unresolved"),
      now: request.now,
    });
  }
  if (claim.kind !== "claimed") {
    return claim;
  }
  const delivery = await adapter.send({
    deliveryKey: claim.entry.deliveryKey,
    payload: claim.entry.payload,
  });
  if (delivery.status === "unknown") {
    return params.store.outbox.markManualReview({
      taskId: request.taskId,
      effectId: request.effectId,
      expectedLeaseEpoch: request.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
      reasonDigest: delivery.reasonDigest,
      now: request.now + 1,
    });
  }
  if (delivery.status === "not_sent") {
    return params.store.outbox.markManualReview({
      taskId: request.taskId,
      effectId: request.effectId,
      expectedLeaseEpoch: request.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
      reasonDigest: delivery.reasonDigest,
      now: request.now + 1,
    });
  }
  const verifiedReceipt = params.store.verifyCertifiedDeliveryReceipt(delivery.receipt);
  if (!verifiedReceipt) {
    return params.store.outbox.markManualReview({
      taskId: request.taskId,
      effectId: request.effectId,
      expectedLeaseEpoch: request.expectedLeaseEpoch,
      expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
      reasonDigest: dispatchReason("invalid_host_delivery_receipt"),
      now: request.now + 1,
    });
  }
  const payloadDigest = (claim.entry.providerReceipt as { payloadDigest?: string } | undefined)
    ?.payloadDigest;
  if (
    !payloadDigest ||
    !receiptMatchesClaim({
      receipt: delivery.receipt,
      deliveryKey: claim.entry.deliveryKey,
      payloadDigest,
    })
  ) {
    throw new Error("Governor delivery receipt binding is mismatched");
  }
  const terminalParams = {
    taskId: request.taskId,
    effectId: request.effectId,
    expectedLeaseEpoch: request.expectedLeaseEpoch,
    expectedDeliveryClaimEpoch: claim.entry.deliveryClaimEpoch,
    workerId: request.workerId,
    verifiedReceipt,
    now: request.now + 1,
  };
  return delivery.status === "would_send"
    ? params.store.outbox.markWouldSend(terminalParams)
    : params.store.outbox.markSent(terminalParams);
}
