import { createGovernorActionFingerprint } from "./action-fingerprint.js";
// Detects semantic no-progress while ignoring volatile request and timestamp metadata.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorActionProposal, GovernorEffectRecord } from "./tool-outcome.js";

const VOLATILE_KEY = /^(?:attemptId|createdAt|eventId|requestId|timestamp|traceId|updatedAt)$/u;

function semanticValue(value: GovernorJsonValue): GovernorJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => semanticValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_KEY.test(key) && !key.endsWith("_at"))
        .map(([key, item]) => [key, semanticValue(item)]),
    );
  }
  return value;
}

export function governorProgressVectorHash(value: GovernorJsonValue): string {
  return governorDigest(semanticValue(value));
}

export type GovernorActionAdmission =
  | { admitted: true; forceReplanAfterOutcome: boolean }
  | {
      admitted: false;
      reason: "no_progress_limit" | "reconcile_before_retry";
      fingerprint: string;
    };

export function evaluateGovernorActionAdmission(params: {
  proposal: GovernorActionProposal;
  progressVector: GovernorJsonValue;
  priorEffects: readonly GovernorEffectRecord[];
  objectiveRevision: number;
}): GovernorActionAdmission {
  const fingerprint = createGovernorActionFingerprint(params.proposal);
  const progressVectorHash = governorProgressVectorHash(params.progressVector);
  if (
    params.priorEffects.some(
      (effect) =>
        effect.objectiveRevision === params.objectiveRevision &&
        effect.actionFingerprint === fingerprint &&
        effect.reconcileRequired,
    )
  ) {
    return { admitted: false, reason: "reconcile_before_retry", fingerprint };
  }
  const equivalentNoDelta = params.priorEffects.filter(
    (effect) =>
      effect.objectiveRevision === params.objectiveRevision &&
      effect.actionFingerprint === fingerprint &&
      effect.progressVectorHash === progressVectorHash,
  ).length;
  if (equivalentNoDelta >= 2) {
    return { admitted: false, reason: "no_progress_limit", fingerprint };
  }
  return { admitted: true, forceReplanAfterOutcome: equivalentNoDelta === 1 };
}
