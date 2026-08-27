import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

const GOVERNOR_SECRET_FIELDS = [
  "identityHmacKey",
  "evidenceAdmissionKey",
  "receiptSigningKey",
  "ledgerSigningKey",
  "deploymentIdentity",
] as const;

/** Adds only enabled governor SecretRefs to the canonical startup assignment plan. */
export function collectBehaviorGovernorSecretAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const governor = params.config.experimental?.behaviorGovernor;
  if (!governor || !("enabled" in governor) || !governor.enabled) {
    return;
  }
  const secretRefs = governor.secretRefs as unknown as Record<string, unknown>;
  if (!isRecord(secretRefs)) {
    return;
  }
  for (const field of GOVERNOR_SECRET_FIELDS) {
    collectSecretInputAssignment({
      value: secretRefs[field],
      path: `experimental.behaviorGovernor.secretRefs.${field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: true,
      apply: (value) => {
        secretRefs[field] = value;
      },
    });
  }
}
