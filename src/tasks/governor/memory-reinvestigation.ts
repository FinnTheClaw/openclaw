// Decides whether a resolved memory contradiction needs another investigation.
import type { GovernorEvidenceRecord } from "./evidence.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import type { GovernorMemoryRecord } from "./memory-integrity.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";

export type GovernorMemoryReinvestigationDecision =
  | { reopen: false; reason: "reuse_resolved" }
  | {
      reopen: true;
      reason:
        | "materially_new_evidence"
        | "replacement_freshness_expired"
        | "different_scope"
        | "operator_requested";
    };

export function evaluateGovernorMemoryReinvestigation(params: {
  remediation: GovernorMemoryRemediation;
  replacement: GovernorMemoryRecord | null;
  evidence?: GovernorEvidenceRecord;
  requestedScopeKey: string;
  operatorRequested?: boolean;
  now: number;
}): GovernorMemoryReinvestigationDecision {
  if (params.operatorRequested) {
    return { reopen: true, reason: "operator_requested" };
  }
  if (params.requestedScopeKey !== params.remediation.scopeKey) {
    return { reopen: true, reason: "different_scope" };
  }
  if (
    params.replacement?.freshnessExpiresAt !== undefined &&
    params.replacement.freshnessExpiresAt <= params.now
  ) {
    return { reopen: true, reason: "replacement_freshness_expired" };
  }
  if (
    params.evidence?.scopeKey === params.remediation.scopeKey &&
    params.evidence.sourceIdentity === params.remediation.canonicalSourceRef &&
    params.evidence.predicate === governorMemoryFactPredicate(params.remediation.factKey) &&
    params.evidence.observedAt > params.remediation.evidenceObservedAt &&
    params.evidence.evidenceDigest !== params.remediation.evidenceDigest
  ) {
    return { reopen: true, reason: "materially_new_evidence" };
  }
  return { reopen: false, reason: "reuse_resolved" };
}
