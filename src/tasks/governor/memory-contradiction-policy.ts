// Pure qualification policy for retiring an active memory after trusted evidence.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  isOpaqueEvidenceSourceRef,
  type GovernorEvidenceRecord,
  type GovernorEvidenceSourceKind,
} from "./evidence.js";
import { normalizeGovernorFactKey, type GovernorMemoryRecord } from "./memory-types.js";

export { normalizeGovernorFactKey } from "./memory-types.js";

const TRUSTED_EVIDENCE_RANK: Partial<Record<GovernorEvidenceSourceKind, number>> = {
  structured_external: 600,
  authenticated_user: 500,
  tool: 400,
};

export type GovernorMemoryEvidencePredicate = Readonly<{
  factKey: string;
  predicate: string;
  currentValue: GovernorJsonValue;
  currentValueDigest: string;
  currentSemanticDigest: string;
}>;

export type GovernorMemoryContradictionRejectReason =
  | "invalid_fact_key"
  | "invalid_contradiction_class"
  | "invalid_scope"
  | "invalid_source_reference"
  | "inactive_memory"
  | "untrusted_source"
  | "not_admitted"
  | "invalidated_evidence"
  | "scope_mismatch"
  | "fact_key_mismatch"
  | "predicate_mismatch"
  | "memory_semantic_digest_mismatch"
  | "evidence_payload_digest_mismatch"
  | "evidence_value_mismatch"
  | "evidence_semantic_digest_mismatch"
  | "same_value"
  | "older_evidence"
  | "replayed_evidence"
  | "lower_authority";

export type GovernorMemoryContradictionResult =
  | {
      kind: "retire";
      reason: "higher_authority" | "newer_same_authority";
      fingerprint: string;
      evidenceRank: number;
    }
  | {
      kind: "unresolved";
      reason: "equal_authority_same_time";
      fingerprint: string;
      evidenceRank: number;
    }
  | {
      kind: "reject";
      reason: GovernorMemoryContradictionRejectReason;
    };

/** Canonicalizes a fact key without changing its meaning or permitting emptiness. */
/** Canonical predicate for one memory fact; callers cannot choose its meaning. */
export function governorMemoryFactPredicate(factKey: string): string {
  return `memory.fact:${normalizeGovernorFactKey(factKey)}`;
}

/** Canonical predicate proving that one stale canonical source was repaired. */
export function governorMemoryRepairPredicate(factKey: string): string {
  return `memory.repair.verified:${normalizeGovernorFactKey(factKey)}`;
}

/** Canonicalizes a contradiction class for stable fingerprints and dedupe. */
export function normalizeGovernorContradictionClass(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Governor contradiction class must be a string");
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/gu, "-")
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.:]+|[-.:]+$/gu, "");
  if (!normalized) {
    throw new Error("Governor contradiction class must not be empty");
  }
  return normalized;
}

/** Creates the current-memory side of an exact fact/predicate comparison. */
export function createGovernorMemoryEvidencePredicate(params: {
  memory: GovernorMemoryRecord;
  factKey?: string;
}): GovernorMemoryEvidencePredicate {
  const factKey = normalizeGovernorFactKey(params.memory.factKey);
  if (params.factKey !== undefined && normalizeGovernorFactKey(params.factKey) !== factKey) {
    throw new Error("Governor memory fact key does not match the record");
  }
  const predicate = governorMemoryFactPredicate(factKey);
  return {
    factKey,
    predicate,
    currentValue: params.memory.content,
    currentValueDigest: governorDigest(params.memory.content),
    currentSemanticDigest: governorDigest({ predicate, value: params.memory.content }),
  };
}

/** Verifies predicate identity and the evidence record's own semantic digest. */
export function isGovernorMemoryEvidencePredicate(params: {
  predicate: GovernorMemoryEvidencePredicate;
  evidence: GovernorEvidenceRecord;
}): boolean {
  return (
    Boolean(params.predicate.factKey) &&
    params.predicate.predicate === governorMemoryFactPredicate(params.predicate.factKey) &&
    params.evidence.predicate === params.predicate.predicate &&
    params.evidence.semanticDigest ===
      governorDigest({ predicate: params.evidence.predicate, value: params.evidence.value })
  );
}

/** Stable dedupe key for one opaque source/fact/scope/contradiction combination. */
export function governorMemoryContradictionFingerprint(params: {
  sourceReference: string;
  factKey: string;
  scopeKey: string;
  contradictionClass: string;
}): string {
  if (!isOpaqueEvidenceSourceRef(params.sourceReference)) {
    throw new Error("Governor contradiction source reference must be opaque");
  }
  if (!params.scopeKey.trim()) {
    throw new Error("Governor contradiction scope key must not be empty");
  }
  return governorDigest({
    sourceReference: params.sourceReference,
    factKey: normalizeGovernorFactKey(params.factKey),
    // Scope keys are already canonical ACL keys; preserve their exact bytes.
    scopeKey: params.scopeKey,
    contradictionClass: normalizeGovernorContradictionClass(params.contradictionClass),
  });
}

function reject(
  reason: GovernorMemoryContradictionRejectReason,
): GovernorMemoryContradictionResult {
  return { kind: "reject", reason };
}

/**
 * Decides only whether trusted evidence may retire this memory. It performs no
 * mutation and deliberately returns unresolved for equal-authority ties.
 */
export function qualifyGovernorMemoryContradiction(params: {
  memory: GovernorMemoryRecord;
  evidence: GovernorEvidenceRecord;
  predicate: GovernorMemoryEvidencePredicate;
  contradictionClass: string;
}): GovernorMemoryContradictionResult {
  let contradictionClass: string;
  try {
    contradictionClass = normalizeGovernorContradictionClass(params.contradictionClass);
  } catch {
    return reject("invalid_contradiction_class");
  }
  if (!params.predicate.factKey.trim()) {
    return reject("invalid_fact_key");
  }
  if (!params.memory.scopeKey.trim() || !params.evidence.scopeKey.trim()) {
    return reject("invalid_scope");
  }
  if (
    params.memory.status !== "verified" ||
    params.memory.tombstonedAt !== undefined ||
    params.memory.scopeEpoch < 0
  ) {
    return reject("inactive_memory");
  }
  if (!isOpaqueEvidenceSourceRef(params.evidence.sourceIdentity)) {
    return reject("invalid_source_reference");
  }
  if (!isOpaqueEvidenceSourceRef(params.memory.provenance.sourceRef)) {
    return reject("invalid_source_reference");
  }
  const evidenceRank = TRUSTED_EVIDENCE_RANK[params.evidence.sourceKind] ?? 0;
  if (evidenceRank === 0) {
    return reject("untrusted_source");
  }
  if (params.evidence.admissibility !== "admitted") {
    return reject("not_admitted");
  }
  if (params.evidence.invalidatedAt !== undefined) {
    return reject("invalidated_evidence");
  }
  if (
    params.evidence.scopeKey !== params.memory.scopeKey ||
    params.evidence.scopeKey !== params.memory.provenance.scopeKey
  ) {
    return reject("scope_mismatch");
  }
  let memoryFactKey: string;
  try {
    memoryFactKey = normalizeGovernorFactKey(params.memory.factKey);
  } catch {
    return reject("invalid_fact_key");
  }
  if (params.predicate.factKey !== memoryFactKey) {
    return reject("fact_key_mismatch");
  }
  if (params.predicate.predicate !== governorMemoryFactPredicate(memoryFactKey)) {
    return reject("predicate_mismatch");
  }
  if (
    params.predicate.currentSemanticDigest !==
    governorDigest({ predicate: params.predicate.predicate, value: params.memory.content })
  ) {
    return reject("memory_semantic_digest_mismatch");
  }
  if (params.evidence.predicate !== params.predicate.predicate) {
    return reject("predicate_mismatch");
  }
  if (governorDigest(params.evidence.payload) !== params.evidence.evidenceDigest) {
    return reject("evidence_payload_digest_mismatch");
  }
  if (governorDigest(params.evidence.payload) !== governorDigest(params.evidence.value)) {
    return reject("evidence_value_mismatch");
  }
  if (!isGovernorMemoryEvidencePredicate(params)) {
    return reject("evidence_semantic_digest_mismatch");
  }
  if (
    params.evidence.evidenceId === params.memory.supersededEvidenceId ||
    params.evidence.evidenceDigest === params.memory.supersededEvidenceDigest
  ) {
    return reject("replayed_evidence");
  }
  if (governorDigest(params.evidence.value) === params.predicate.currentValueDigest) {
    return reject("same_value");
  }
  if (params.evidence.observedAt < params.memory.observedAt) {
    return reject("older_evidence");
  }
  const fingerprint = governorMemoryContradictionFingerprint({
    sourceReference: params.memory.provenance.sourceRef,
    factKey: params.predicate.factKey,
    scopeKey: params.evidence.scopeKey,
    contradictionClass,
  });
  if (evidenceRank < params.memory.sourceRank) {
    return reject("lower_authority");
  }
  if (evidenceRank === params.memory.sourceRank) {
    if (params.evidence.observedAt < params.memory.observedAt) {
      return reject("older_evidence");
    }
    if (params.evidence.observedAt === params.memory.observedAt) {
      return {
        kind: "unresolved",
        reason: "equal_authority_same_time",
        fingerprint,
        evidenceRank,
      };
    }
    return {
      kind: "retire",
      reason: "newer_same_authority",
      fingerprint,
      evidenceRank,
    };
  }
  return { kind: "retire", reason: "higher_authority", fingerprint, evidenceRank };
}
