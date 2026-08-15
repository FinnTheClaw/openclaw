// Defines the canonical content/provenance payload authenticated by host memory authority.
import type { GovernorMemoryAuthorityBinding } from "../../security/governor-host-readonly.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorMemoryRecord } from "./memory-types.js";

export function createGovernorMemoryAuthorityBinding(
  memory: GovernorMemoryRecord,
): GovernorMemoryAuthorityBinding {
  if (
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest ||
    !memory.verifiedEvidenceTaskId ||
    memory.provenance.evidenceTaskId !== memory.verifiedEvidenceTaskId ||
    memory.provenance.evidenceTaskVersion === undefined ||
    memory.provenance.objectiveRevision === undefined ||
    memory.provenance.planVersion === undefined ||
    memory.provenance.recordedAt === undefined
  ) {
    throw new Error("GOVERNOR_MEMORY_AUTHORITY_BINDING_REQUIRED");
  }
  return {
    scopeKey: memory.scopeKey,
    factKey: memory.factKey,
    scopeEpoch: memory.scopeEpoch,
    memoryId: memory.memoryId,
    sourceKind: memory.sourceKind,
    sourceIdentity: memory.sourceIdentity,
    sourceReference: memory.provenance.sourceRef,
    freshnessExpiresAt: memory.freshnessExpiresAt ?? null,
    sensitivity: memory.sensitivity,
    authority: memory.sourceRank / 1000,
    authorityRank: memory.sourceRank,
    generation: memory.authorityGeneration ?? 0,
    sourceEvidenceId: memory.verifiedEvidenceId!,
    sourceEvidenceLineage: [],
    sourceMemoryLineage: memory.supersedesId ? [memory.supersedesId] : [],
    factDigest: governorDigest({
      scopeKey: memory.scopeKey,
      scopeEpoch: memory.scopeEpoch,
      factKey: memory.factKey,
    }),
    contentDigest: memory.contentDigest,
    provenanceDigest: governorDigest(memory.provenance),
    evidenceDigest: memory.verifiedEvidenceDigest,
    semanticDigest: memory.verifiedEvidenceSemanticDigest,
    ordering: {
      scopeEpoch: memory.scopeEpoch,
      observedAt: memory.observedAt,
      recordedAt: memory.provenance.recordedAt,
      sourceRank: memory.sourceRank,
      confidenceMillionths: Math.round(memory.confidence * 1_000_000),
      taskVersion: memory.provenance.evidenceTaskVersion,
      objectiveRevision: memory.provenance.objectiveRevision,
      planVersion: memory.provenance.planVersion,
      taskDigest: governorDigest({ taskId: memory.verifiedEvidenceTaskId }),
    },
  };
}

export function governorMemoryAuthorityBindingDigest(memory: GovernorMemoryRecord): string {
  return governorDigest({
    kind: "memory-current",
    ...createGovernorMemoryAuthorityBinding(memory),
  } as unknown as GovernorJsonValue);
}
