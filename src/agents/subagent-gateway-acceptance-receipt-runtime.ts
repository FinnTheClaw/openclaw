/** Gateway-owned receipt signer generation from the prepared SecretRef snapshot. */
let active:
  | Readonly<{
      signingKey: string;
      generation: string;
    }>
  | undefined;

export function installGatewayAcceptanceReceiptSigner(params: {
  signingKey: string;
  generation: string;
}): void {
  if (!params.signingKey.trim() || !params.generation.trim()) {
    throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNER_INVALID");
  }
  active = Object.freeze({
    signingKey: params.signingKey,
    generation: params.generation,
  });
}

export function clearGatewayAcceptanceReceiptSigner(): void {
  active = undefined;
}

export function readGatewayAcceptanceReceiptSigner():
  | Readonly<{
      signingKey: string;
      generation: string;
    }>
  | undefined {
  return active;
}
