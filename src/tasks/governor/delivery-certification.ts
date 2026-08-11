// Host-owned adapter registration and certification primitives.
import crypto from "node:crypto";
import { canonicalGovernorJson, governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { opaqueGovernorReference } from "./types.js";

export type GovernorDeliveryAdapterIdentity = {
  adapterId: string;
  version: string;
  capability: string;
};
export type GovernorDeliveryAdapter = {
  send: (params: { deliveryKey: string; payload: GovernorJsonValue }) => Promise<{
    deliveryKey: string;
    receipt: GovernorJsonValue;
  }>;
};
export type GovernorRegisteredDeliveryAdapter = {
  handle: string;
  identity: GovernorDeliveryAdapterIdentity;
  implementationDigest: string;
  configDigest: string;
  adapter: GovernorDeliveryAdapter;
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

export function governorDeliveryRegistrationKey(params: {
  identity: GovernorDeliveryAdapterIdentity;
  implementationDigest: string;
  configDigest: string;
}): string {
  return opaqueGovernorReference("delivery-registration", canonicalGovernorJson(params));
}

/** This registry is deliberately controller-owned: dispatches receive a handle, never an adapter. */
export class GovernorHostDeliveryRegistry {
  readonly #entries = new Map<string, GovernorRegisteredDeliveryAdapter>();

  register(params: {
    identity: GovernorDeliveryAdapterIdentity;
    adapter: GovernorDeliveryAdapter;
    config: GovernorJsonValue;
  }): GovernorRegisteredDeliveryAdapter {
    const implementationDigest = governorDigest({ source: String(params.adapter.send) });
    const configDigest = governorDigest(params.config);
    const handle = governorDeliveryRegistrationKey({
      identity: params.identity,
      implementationDigest,
      configDigest,
    });
    const entry: GovernorRegisteredDeliveryAdapter = {
      handle,
      identity: structuredClone(params.identity),
      implementationDigest,
      configDigest,
      adapter: params.adapter,
    };
    this.#entries.set(handle, entry);
    return entry;
  }

  resolve(handle: string): GovernorRegisteredDeliveryAdapter {
    const entry = this.#entries.get(handle);
    if (!entry) {
      throw new Error("Governor delivery adapter handle is not host-registered");
    }
    return entry;
  }
}

export class GovernorHostDeliveryCertificationAuthority {
  readonly #key: string;
  readonly #keyId: string;
  private constructor(key: string, keyId: string) {
    this.#key = key;
    this.#keyId = keyId;
  }
  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): GovernorHostDeliveryCertificationAuthority {
    return new GovernorHostDeliveryCertificationAuthority(
      certificationKey(env),
      env.OPENCLAW_GOVERNOR_DELIVERY_CERTIFICATION_KEY_ID?.trim() || "v1",
    );
  }
  get keyId(): string {
    return this.#keyId;
  }
  sign(params: {
    registrationKey: string;
    status: "certified" | "revoked";
    generation: number;
    keyId: string;
    version: number;
  }): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson(params))
      .digest("hex");
  }
  verifies(params: {
    registrationKey: string;
    status: "certified" | "revoked";
    generation: number;
    keyId: string;
    version: number;
    signature: string;
  }): boolean {
    if (params.keyId !== this.#keyId || params.version !== 1) {
      return false;
    }
    const { signature: _signature, ...unsigned } = params;
    const expected = this.sign(unsigned);
    return (
      params.signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(params.signature), Buffer.from(expected))
    );
  }
}
