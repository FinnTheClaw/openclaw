// Derives stable action identity independently of attempt and transport metadata.
import { governorDigest } from "./canonical-json.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import { opaqueGovernorReference } from "./types.js";

function targetFingerprint(target: string): string {
  return /^[a-f0-9]{64}$/u.test(target) ? target : opaqueGovernorReference("action-target", target);
}

export function createGovernorActionFingerprint(proposal: GovernorActionProposal): string {
  return governorDigest({
    capability: proposal.capability,
    capabilityVersion: proposal.capabilityVersion,
    canonicalTarget: targetFingerprint(proposal.canonicalTarget),
    criterionId: proposal.criterionId ?? null,
    argumentsDigest: proposal.argumentsDigest,
    mutating: proposal.mutating,
  });
}
