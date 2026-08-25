import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
  readGatewayAcceptanceReceiptSigner,
} from "../agents/subagent-gateway-acceptance-receipt-runtime.js";
import { revokeAndCloseBehaviorGovernor } from "./behavior-governor-close.js";

describe("behavior governor close ordering", () => {
  afterEach(() => clearGatewayAcceptanceReceiptSigner());

  it("revokes the receipt signer even when lifecycle close fails", async () => {
    installGatewayAcceptanceReceiptSigner({ signingKey: "fixture-key", generation: "fixture-v1" });
    const close = vi.fn(async () => {
      expect(readGatewayAcceptanceReceiptSigner()).toBeUndefined();
      throw new Error("close failed");
    });

    await expect(
      revokeAndCloseBehaviorGovernor({
        lifecycle: { close } as never,
        revoke: clearGatewayAcceptanceReceiptSigner,
      }),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(readGatewayAcceptanceReceiptSigner()).toBeUndefined();
  });
});
