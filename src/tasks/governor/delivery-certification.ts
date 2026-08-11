// Keeps delivery-key idempotency authority at the host adapter boundary.
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";

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

export type GovernorDeliveryCertification = GovernorDeliveryAdapterIdentity & {
  status: "certified" | "revoked";
};

function key(identity: GovernorDeliveryAdapterIdentity): string {
  const safe = assertGovernorBoundarySafe("log", identity) as GovernorDeliveryAdapterIdentity;
  return `${safe.adapterId}\u0000${safe.version}\u0000${safe.capability}`;
}

export class GovernorDeliveryCertificationRegistry {
  readonly #certifications: ReadonlyMap<string, GovernorDeliveryCertification>;

  constructor(certifications: readonly GovernorDeliveryCertification[]) {
    this.#certifications = new Map(
      certifications.map((certification) => [key(certification), { ...certification }]),
    );
  }

  status(identity: GovernorDeliveryAdapterIdentity): "certified" | "revoked" | "uncertified" {
    return this.#certifications.get(key(identity))?.status ?? "uncertified";
  }

  assertCertified(identity: GovernorDeliveryAdapterIdentity): void {
    const status = this.status(identity);
    if (status !== "certified") {
      throw new Error(`Governor delivery adapter is ${status}`);
    }
  }
}
