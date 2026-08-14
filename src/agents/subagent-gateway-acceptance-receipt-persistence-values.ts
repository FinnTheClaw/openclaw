import {
  buildGatewayAcceptanceReceiptEnvelope,
  createGatewayAcceptanceReceiptProof,
  type GatewayAcceptanceReceiptEnvelope,
} from "./subagent-gateway-acceptance-receipt-auth.js";
import type { GatewayAcceptanceReceiptLifecycle } from "./subagent-gateway-acceptance-receipt-types.js";

export function signedReceiptValues(params: {
  envelope: GatewayAcceptanceReceiptEnvelope;
  lifecycle: GatewayAcceptanceReceiptLifecycle;
  cancelEpoch: number;
  nonce?: string;
}) {
  const proof = createGatewayAcceptanceReceiptProof({
    envelope: params.envelope,
    lifecycle: params.lifecycle,
    cancelEpoch: params.cancelEpoch,
    ...(params.nonce ? { nonce: params.nonce } : {}),
  });
  return {
    envelope_digest: proof.envelopeDigest,
    envelope_json: JSON.stringify(params.envelope),
    key_id: proof.keyId,
    nonce: proof.nonce,
    signature: proof.signature,
  };
}

export function defaultReceiptEnvelope(params: {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  requestDigest: string;
  resolvedDigest: string;
  gatewayRunId: string;
  childSessionKey: string;
  acceptanceEpoch: string;
  receiptGeneration: number;
}): GatewayAcceptanceReceiptEnvelope {
  return buildGatewayAcceptanceReceiptEnvelope({
    ...params,
    request: {},
  });
}
