/** Runtime-only governor secrets resolved once by trusted host bootstrap. */
import {
  createGovernorIdentityContext,
  type GovernorIdentityContext,
} from "../tasks/governor/types.js";

const REQUIRED_KEYS = {
  identityHmacKey: "OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY",
  evidenceAdmissionKey: "OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY",
  receiptSigningKey: "OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY",
  ledgerSigningKey: "OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY",
} as const;

export type GovernorSecrets = Readonly<{
  identityHmacKey: string;
  identity: GovernorIdentityContext;
  evidenceAdmissionKey: string;
  evidenceAdmissionKeyId: string;
  receiptSigningKey: string;
  ledgerSigningKey: string;
  runtimeMode: "production" | "test";
}>;

const CONTEXTS = new WeakSet<object>();

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when the behavior governor is enabled`);
  }
  if (value.length < 16) {
    throw new Error(`${name} must contain at least 16 characters`);
  }
  return value;
}

/** Trusted bootstrap is the only production caller of this constructor. */
export function resolveGovernorSecrets(env: NodeJS.ProcessEnv): GovernorSecrets {
  const identityHmacKey = required(env, REQUIRED_KEYS.identityHmacKey);
  const evidenceAdmissionKey = required(env, REQUIRED_KEYS.evidenceAdmissionKey);
  const receiptSigningKey = required(env, REQUIRED_KEYS.receiptSigningKey);
  const ledgerSigningKey = required(env, REQUIRED_KEYS.ledgerSigningKey);
  if (
    new Set([identityHmacKey, evidenceAdmissionKey, receiptSigningKey, ledgerSigningKey]).size < 4
  ) {
    throw new Error("Governor HMAC keys must be independently provisioned");
  }
  const context = Object.freeze({
    identityHmacKey,
    identity: createGovernorIdentityContext(identityHmacKey),
    evidenceAdmissionKey,
    evidenceAdmissionKeyId: env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID?.trim() || "v1",
    receiptSigningKey,
    ledgerSigningKey,
    runtimeMode: env.NODE_ENV === "test" ? "test" : "production",
  });
  CONTEXTS.add(context);
  return context;
}

export function isGovernorSecrets(value: GovernorSecrets): boolean {
  return CONTEXTS.has(value);
}

export function syntheticGovernorSecretsEnvironment(stateDir?: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...(stateDir ? { OPENCLAW_STATE_DIR: stateDir } : {}),
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "synthetic-governor-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "synthetic-governor-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "synthetic-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "synthetic-governor-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "synthetic-governor-ledger-key",
  };
}
