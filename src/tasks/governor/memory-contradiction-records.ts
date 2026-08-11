// Derives deterministic replacement and remediation record identities.
import { governorDigest } from "./canonical-json.js";
import type { GovernorMemorySourceKind } from "./memory-integrity.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";

export function governorMemoryConfidence(sourceKind: GovernorMemorySourceKind): number {
  switch (sourceKind) {
    case "structured_external":
      return 0.95;
    case "authenticated_user":
      return 0.9;
    case "tool":
      return 0.85;
    default:
      return 0;
  }
}

export function governorMemoryReplacementId(params: {
  scopeKey: string;
  factKey: string;
  evidenceDigest: string;
  semanticDigest: string;
}): string {
  return `gmem_${governorDigest(params).slice(0, 40)}`;
}

export function governorMemoryRepairEffectId(fingerprint: string, evidenceDigest: string): string {
  return `geffect_memory-repair-${fingerprint.slice(0, 20)}-${evidenceDigest.slice(0, 12)}`;
}

export function governorMemoryRemediationTaskId(
  existing: GovernorMemoryRemediation | null,
  evidenceTaskId: GovernorMemoryRemediation["taskId"],
): GovernorMemoryRemediation["taskId"] {
  return existing && ["unresolved", "queued", "repairing"].includes(existing.status)
    ? existing.taskId
    : evidenceTaskId;
}
