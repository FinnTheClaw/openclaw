import type { GovernorActionProposal } from "./action-contracts.js";
// Derives stable action identity independently of attempt and transport metadata.
import { governorDigest } from "./canonical-json.js";
import { opaqueGovernorReference, type GovernorIdentityContext } from "./types.js";

function targetFingerprint(target: string, identity: GovernorIdentityContext): string {
  return /^[a-f0-9]{64}$/u.test(target)
    ? target
    : opaqueGovernorReference("action-target", target, identity);
}

export function createGovernorActionFingerprint(
  proposal: GovernorActionProposal,
  identity: GovernorIdentityContext,
): string {
  return governorDigest({
    capability: proposal.capability,
    capabilityVersion: proposal.capabilityVersion,
    canonicalTarget: targetFingerprint(proposal.canonicalTarget, identity),
    criterionId: proposal.criterionId ?? null,
    argumentsDigest: proposal.argumentsDigest,
    mutating: proposal.mutating,
  });
}
