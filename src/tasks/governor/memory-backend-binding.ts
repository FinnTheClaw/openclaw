import { createHash } from "node:crypto";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { GovernorMemoryRecord } from "./memory-integrity.js";

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function contentDigest(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Converts only an authenticated canonical verified record into the plugin contract. */
export function toGovernorBackendFact(memory: GovernorMemoryRecord): MemoryGovernorFact {
  if (
    memory.status !== "verified" ||
    !memory.verifiedEvidenceId ||
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest
  ) {
    throw new Error("GOVERNOR_MEMORY_BACKEND_VERIFIED_BINDING_REQUIRED");
  }
  const semanticDigest = memory.verifiedEvidenceSemanticDigest;
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
    contentDigest: contentDigest(memory.content),
    status: "verified",
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
    authorityBindingDigest: digest(
      "authority",
      memory.scopeKey,
      memory.factKey,
      memory.verifiedEvidenceId,
      memory.verifiedEvidenceDigest,
      semanticDigest,
    ),
    sourceEvidenceId: memory.verifiedEvidenceId,
    sourceEvidenceDigest: memory.verifiedEvidenceDigest,
    sourceEvidenceSemanticDigest: semanticDigest,
    ...(memory.supersedesId ? { sourceMemoryLineage: [memory.supersedesId] } : {}),
  };
}
