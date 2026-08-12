// Stable, bounded failures for durable governor codecs and untrusted identifiers.
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { DEFAULT_GOVERNOR_JSON_RESOURCE_LIMITS } from "./resource-guard.js";
import type { GovernorSecretBoundary } from "./secret-filter.js";

export class GovernorIntegrityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GovernorIntegrityError";
    this.code = code;
  }
}

export function failGovernorIntegrity(code: string): never {
  throw new GovernorIntegrityError(code);
}

export function parseGovernorStoredJson(
  raw: string,
  boundary: GovernorSecretBoundary,
  code: string,
): GovernorJsonValue {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > DEFAULT_GOVERNOR_JSON_RESOURCE_LIMITS.maxUtf8Bytes
  ) {
    return failGovernorIntegrity(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return failGovernorIntegrity(code);
  }
  return assertGovernorPersistedJson(boundary, parsed);
}

export function safeGovernorErrorCode(error: unknown): string {
  if (
    error instanceof GovernorIntegrityError ||
    (error instanceof Error && /^GOVERNOR_[A-Z0-9_]+$/u.test(error.message))
  ) {
    return error.message;
  }
  return "GOVERNOR_OPERATION_REJECTED";
}
