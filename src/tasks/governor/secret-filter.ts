// Redacts or rejects secret-like content before any model, memory, embedding, session, or log sink.
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorJsonResources } from "./resource-guard.js";

export type GovernorSecretBoundary = "model" | "memory" | "embedding" | "session" | "log";

export type GovernorSecretFinding = {
  code: "sensitive_field" | "credential_pattern" | "private_key" | "secret_canary";
  path: string;
};

export type GovernorSecretScan = {
  safe: boolean;
  redacted: GovernorJsonValue;
  findings: readonly GovernorSecretFinding[];
};

const CREDENTIAL_PATTERNS = [
  /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const SECRET_CANARY = /GOVERNOR_SECRET_CANARY_[A-Za-z0-9_-]+/gu;
const REDACTED = "[REDACTED]";

function canonicalFieldName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function isSensitiveFieldName(value: string): boolean {
  const name = canonicalFieldName(value);
  return (
    name === "auth" ||
    name === "authorization" ||
    name === "credential" ||
    name === "password" ||
    name === "privatekey" ||
    name === "secret" ||
    name === "apikey" ||
    name === "accesskey" ||
    name === "accesskeyid" ||
    name.includes("credential") ||
    name.includes("password") ||
    name.includes("privatekey") ||
    name.includes("secret") ||
    name.endsWith("token") ||
    name.endsWith("apikey") ||
    name.endsWith("accesskey")
  );
}

function redactString(value: string, path: string, findings: GovernorSecretFinding[]): string {
  let redacted = value.replace(PRIVATE_KEY, () => {
    findings.push({ code: "private_key", path });
    return REDACTED;
  });
  redacted = redacted.replace(SECRET_CANARY, () => {
    findings.push({ code: "secret_canary", path });
    return REDACTED;
  });
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      findings.push({ code: "credential_pattern", path });
      return REDACTED;
    });
  }
  return redacted;
}

function scanValue(
  value: GovernorJsonValue,
  path: string,
  findings: GovernorSecretFinding[],
): GovernorJsonValue {
  if (typeof value === "string") {
    return redactString(value, path, findings);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => scanValue(item, `${path}[${index}]`, findings));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const itemPath = `${path}.${key}`;
        if (isSensitiveFieldName(key)) {
          findings.push({ code: "sensitive_field", path: itemPath });
          return [key, REDACTED];
        }
        return [key, scanValue(item, itemPath, findings)];
      }),
    );
  }
  return value;
}

export function scanGovernorSecrets(value: GovernorJsonValue): GovernorSecretScan {
  assertGovernorJsonResources(value);
  const findings: GovernorSecretFinding[] = [];
  const redacted = scanValue(value, "$", findings);
  return { safe: findings.length === 0, redacted, findings };
}

export class GovernorSecretRejectedError extends Error {
  readonly code = "governor_secret_rejected";

  constructor(
    readonly boundary: GovernorSecretBoundary,
    readonly findings: readonly GovernorSecretFinding[],
  ) {
    super(`Governor rejected secret-like content before ${boundary}`);
  }
}

export function assertGovernorBoundarySafe(
  boundary: GovernorSecretBoundary,
  value: GovernorJsonValue,
): GovernorJsonValue {
  const scan = scanGovernorSecrets(value);
  if (!scan.safe) {
    throw new GovernorSecretRejectedError(boundary, scan.findings);
  }
  return scan.redacted;
}
