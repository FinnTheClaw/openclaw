import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorMemoryRecord } from "./memory-integrity.js";

function authorityBindingDigest(memory: GovernorMemoryRecord): string {
  const binding = {
    scopeKey: memory.scopeKey,
    factKey: memory.factKey,
    scopeEpoch: memory.scopeEpoch,
    memoryId: memory.memoryId,
    sourceKind: memory.sourceKind,
    sourceIdentity: memory.sourceIdentity,
    sourceReference: memory.provenance.sourceRef,
    freshnessExpiresAt: memory.freshnessExpiresAt ?? null,
    sensitivity: memory.sensitivity,
    factDigest: governorDigest({
      scopeKey: memory.scopeKey,
      scopeEpoch: memory.scopeEpoch,
      factKey: memory.factKey,
    }),
    contentDigest: memory.contentDigest,
    provenanceDigest: governorDigest(memory.provenance as unknown as GovernorJsonValue),
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
      taskDigest: governorDigest({ taskId: memory.verifiedEvidenceTaskId } as GovernorJsonValue),
    },
  };
  return governorDigest({ kind: "memory-current", ...binding } as unknown as GovernorJsonValue);
}

/** Converts only an authenticated canonical verified record into the plugin contract. */
export function toGovernorBackendFact(memory: GovernorMemoryRecord): MemoryGovernorFact {
  if (
    memory.status !== "verified" ||
    !memory.verifiedEvidenceId ||
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest ||
    !memory.authorityBindingDigest ||
    memory.provenance.evidenceTaskVersion === undefined ||
    memory.provenance.objectiveRevision === undefined ||
    memory.provenance.planVersion === undefined ||
    memory.provenance.recordedAt === undefined
  ) {
    throw new Error("GOVERNOR_MEMORY_BACKEND_VERIFIED_BINDING_REQUIRED");
  }
  const semanticDigest = memory.verifiedEvidenceSemanticDigest;
  const expectedBinding = authorityBindingDigest(memory);
  if (memory.authorityBindingDigest !== expectedBinding) {
    throw new Error("GOVERNOR_MEMORY_BACKEND_AUTHORITY_BINDING_INVALID");
  }
  return {
    memoryId: memory.memoryId,
    agentId: "governor",
    scope: memory.scopeKey,
    scopeKey: memory.scopeKey,
    scopeEpoch: memory.scopeEpoch,
    factKey: memory.factKey,
    subject: memory.factKey,
    predicate: memory.factKey,
    object: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    text: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    content: memory.content,
    contentDigest: memory.contentDigest,
    status: "verified",
    sensitivity: memory.sensitivity,
    sourceKind:
      memory.sourceKind === "structured_external" ||
      memory.sourceKind === "authenticated_user" ||
      memory.sourceKind === "tool" ||
      memory.sourceKind === "historical_memory"
        ? memory.sourceKind
        : "tool",
    sourceIdentity: memory.sourceIdentity,
    sourceRank: memory.sourceRank,
    confidence: memory.confidence,
    authority: memory.confidence,
    generation: memory.authorityGeneration ?? 0,
    observedAt: memory.observedAt,
    ...(memory.freshnessExpiresAt === undefined
      ? {}
      : { freshnessExpiresAt: memory.freshnessExpiresAt }),
    provenance: {
      ...memory.provenance,
      sourceRef: memory.provenance.sourceRef,
      scopeKey: memory.scopeKey,
      evidenceTaskId: memory.verifiedEvidenceTaskId,
    },
    authorityBindingDigest: expectedBinding,
    sourceEvidenceId: memory.verifiedEvidenceId,
    sourceEvidenceDigest: memory.verifiedEvidenceDigest,
    sourceEvidenceSemanticDigest: semanticDigest,
    ...(memory.supersedesId ? { sourceMemoryLineage: [memory.supersedesId] } : {}),
  };
}
