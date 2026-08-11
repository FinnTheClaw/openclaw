// Task-facing delivery shapes. Host registration and certification live in the core broker.
import type { GovernorJsonValue } from "./canonical-json.js";

export type GovernorDeliveryAdapterIdentity = Readonly<{
  adapterId: string;
  version: string;
  capability: string;
}>;

export type GovernorDeliveryAdapter = Readonly<{
  send: (params: { deliveryKey: string; payload: GovernorJsonValue }) => Promise<{
    deliveryKey: string;
    receipt: GovernorJsonValue;
  }>;
}>;
