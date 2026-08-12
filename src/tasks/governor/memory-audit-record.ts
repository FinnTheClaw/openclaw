import { governorDigest } from "./canonical-json.js";
import type { GovernorMemoryRecord } from "./memory-types.js";

export function quarantineGovernorMemoryAuditRecord(
  memory: GovernorMemoryRecord,
): GovernorMemoryRecord {
  const content = { quarantined: true } as const;
  return {
    ...memory,
    status: "quarantined",
    sourceKind: "historical_memory",
    sourceIdentity: "quarantined",
    sourceRank: 0,
    confidence: 0,
    provenance: {
      sourceRef: "quarantined",
      observedAt: memory.observedAt,
      recordedAt: memory.updatedAt,
      scopeKey: memory.scopeKey,
      confidence: 0,
      sensitivity: memory.sensitivity,
    },
    content,
    contentDigest: governorDigest(content),
  };
}
