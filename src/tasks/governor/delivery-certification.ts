// Defines the host-held authority required to certify a delivery adapter.
import crypto from "node:crypto";
import { canonicalGovernorJson, type GovernorJsonValue } from "./canonical-json.js";
import { opaqueGovernorReference } from "./types.js";

export type GovernorDeliveryAdapterIdentity = {
  adapterId: string;
  version: string;
  capability: string;
};

export type GovernorDeliveryAdapter = {
  identity: GovernorDeliveryAdapterIdentity;
  send: (params: { deliveryKey: string; payload: GovernorJsonValue }) => Promise<{
    deliveryKey: string;
    receipt: GovernorJsonValue;
  }>;
};

function certificationKey(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCLAW_GOVERNOR_DELIVERY_CERTIFICATION_KEY?.trim();
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "test") {
    return "governor-test-delivery-certification-key";
  }
  throw new Error("OPENCLAW_GOVERNOR_DELIVERY_CERTIFICATION_KEY is required for enabled delivery");
}

export function governorDeliveryIdentityKey(identity: GovernorDeliveryAdapterIdentity): string {
  return opaqueGovernorReference("delivery-adapter", canonicalGovernorJson(identity));
}

/** Only code with the host-held certification key can create this authority. */
export class GovernorHostDeliveryCertificationAuthority {
  readonly #key: string;

  private constructor(key: string) {
    this.#key = key;
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): GovernorHostDeliveryCertificationAuthority {
    return new GovernorHostDeliveryCertificationAuthority(certificationKey(env));
  }

  sign(identityKey: string, status: "certified" | "revoked"): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson({ identityKey, status, version: 1 }))
      .digest("hex");
  }

  verifies(identityKey: string, status: "certified" | "revoked", signature: string): boolean {
    const expected = this.sign(identityKey, status);
    return (
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  }
}
