import crypto from "node:crypto";
import { canonicalGovernorJson, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { HostGovernorCapabilities } from "./governor-host-contracts.js";

export function signGovernorDelivery(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

export function opaqueGovernorDeliveryId(key: string, value: GovernorJsonValue): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

export function assertGovernorDeliveryRegistrationInput(
  input: Parameters<HostGovernorCapabilities["registerStaticDeliveryAdapter"]>[0],
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "Governor host delivery registration accepts only implementationId, config, and generation",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "implementationId" && key !== "config" && key !== "generation") ||
        !("value" in descriptors[key]),
    )
  ) {
    throw new Error(
      "Governor host delivery registration accepts only implementationId, config, and generation",
    );
  }
}
