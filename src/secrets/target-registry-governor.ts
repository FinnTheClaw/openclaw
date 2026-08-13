import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const GOVERNOR_SECRET_FIELDS = [
  "identityHmacKey",
  "evidenceAdmissionKey",
  "receiptSigningKey",
  "ledgerSigningKey",
  "deploymentIdentity",
] as const;

const SECRET_INPUT_SHAPE: SecretTargetRegistryEntry["secretShape"] = "secret_input"; // pragma: allowlist secret

function createGovernorSecretTargetEntry(
  field: (typeof GOVERNOR_SECRET_FIELDS)[number],
): SecretTargetRegistryEntry {
  return {
    id: `experimental.behaviorGovernor.secretRefs.${field}`,
    targetType: "experimental.behaviorGovernor.secretRef",
    configFile: "openclaw.json",
    pathPattern: `experimental.behaviorGovernor.secretRefs.${field}`,
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: false,
    includeInConfigure: false,
    includeInAudit: true,
  };
}

export const GOVERNOR_SECRET_TARGET_REGISTRY: readonly SecretTargetRegistryEntry[] =
  GOVERNOR_SECRET_FIELDS.map(createGovernorSecretTargetEntry);
