// Derives stable action identity independently of attempt and transport metadata.
import { governorDigest } from "./canonical-json.js";
import type { GovernorActionProposal } from "./tool-outcome.js";

export function createGovernorActionFingerprint(proposal: GovernorActionProposal): string {
  return governorDigest({
    capability: proposal.capability,
    capabilityVersion: proposal.capabilityVersion,
    canonicalTarget: proposal.canonicalTarget,
    criterionId: proposal.criterionId ?? null,
    argumentsDigest: proposal.argumentsDigest,
    mutating: proposal.mutating,
  });
}
