/** Gateway-owned receipt signer generation from the prepared SecretRef snapshot. */
let active:
  | Readonly<{
      signingKey: string;
      generation: string;
    }>
  | undefined;
let previous: readonly Readonly<{ signingKey: string; generation: string }>[] = [];

export function installGatewayAcceptanceReceiptSigner(params: {
  signingKey: string;
  generation: string;
  previousKeys?: readonly { signingKey: string; generation: string }[];
}): void {
  if (!params.signingKey.trim() || !params.generation.trim()) {
    throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNER_INVALID");
  }
  active = Object.freeze({
    signingKey: params.signingKey,
    generation: params.generation,
  });
  previous = Object.freeze(
    (params.previousKeys ?? [])
      .filter((key) => key.signingKey.trim() && key.generation.trim())
      .map((key) => Object.freeze({ ...key })),
  );
}

export function clearGatewayAcceptanceReceiptSigner(): void {
  active = undefined;
  previous = [];
}

export function readGatewayAcceptanceReceiptSigner():
  | Readonly<{
      signingKey: string;
      generation: string;
    }>
  | undefined {
  return active;
}

export function readGatewayAcceptanceReceiptSigners(): readonly Readonly<{
  signingKey: string;
  generation: string;
}>[] {
  return active ? [active, ...previous] : previous;
}
