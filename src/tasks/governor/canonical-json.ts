// Produces stable JSON and digests for governor evidence and idempotency boundaries.
import crypto from "node:crypto";

export type GovernorJsonValue =
  | null
  | boolean
  | number
  | string
  | GovernorJsonValue[]
  | { [key: string]: GovernorJsonValue };

function normalizeJson(value: GovernorJsonValue): GovernorJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

export function canonicalGovernorJson(value: GovernorJsonValue): string {
  return JSON.stringify(normalizeJson(value));
}

export function governorDigest(value: GovernorJsonValue): string {
  return crypto.createHash("sha256").update(canonicalGovernorJson(value)).digest("hex");
}

export function governorTextDigest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
