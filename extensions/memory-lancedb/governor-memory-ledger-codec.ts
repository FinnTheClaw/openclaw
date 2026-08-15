import { createHash } from "node:crypto";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { assertMemoryContentSafe } from "./memory-content-guard.js";

export type GovernorLedgerSqlRow = Record<string, unknown>;
type Optional<T> = T | undefined;

function governorDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonical);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function text(value: string, label: string, max = 4096): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return normalized;
}

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`governor memory ${label} must be between 0 and 1`);
  }
  return value;
}

const SOURCE_RANK: Record<MemoryGovernorFact["sourceKind"], number> = {
  structured_external: 600,
  authenticated_user: 500,
  tool: 400,
  historical_memory: 200,
};

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return value;
}

function lineage(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`governor memory ${label} is invalid`);
  }
  return [...new Set(value.map((item) => text(item, label, 256)))];
}

export function normalizeGovernorFact(fact: MemoryGovernorFact): MemoryGovernorFact {
  const scopeKey = text(fact.scopeKey, "scopeKey", 1024);
  const factKey = text(fact.factKey, "factKey", 256).toLowerCase();
  if (factKey !== fact.factKey || !/^[a-z0-9][a-z0-9._:-]*$/u.test(factKey)) {
    throw new Error("governor memory factKey is not canonical");
  }
  if (!Number.isSafeInteger(fact.scopeEpoch) || fact.scopeEpoch < 0) {
    throw new Error("governor memory scopeEpoch is invalid");
  }
  if (
    fact.status !== "verified" ||
    SOURCE_RANK[fact.sourceKind] !== fact.sourceRank ||
    (fact.sensitivity !== "normal" && fact.sensitivity !== "sensitive")
  ) {
    throw new Error("governor memory authority status is invalid");
  }
  if (
    fact.provenance.scopeKey !== scopeKey ||
    fact.provenance.observedAt !== fact.observedAt ||
    fact.provenance.confidence !== fact.confidence ||
    fact.provenance.sourceRef !== fact.sourceIdentity
  ) {
    throw new Error("governor memory provenance binding is invalid");
  }
  if (fact.contentDigest !== governorDigest(fact.content)) {
    throw new Error("governor memory content digest is invalid");
  }
  const expectedBinding = governorDigest({
    kind: "memory-current",
    scopeKey,
    factKey,
    scopeEpoch: fact.scopeEpoch,
    memoryId: fact.memoryId,
    sourceKind: fact.sourceKind,
    sourceIdentity: fact.sourceIdentity,
    sourceReference: fact.provenance.sourceRef,
    freshnessExpiresAt: fact.freshnessExpiresAt ?? null,
    sensitivity: fact.sensitivity,
    factDigest: governorDigest({ scopeKey, scopeEpoch: fact.scopeEpoch, factKey }),
    contentDigest: fact.contentDigest,
    provenanceDigest: governorDigest(fact.provenance),
    evidenceDigest: fact.sourceEvidenceDigest,
    semanticDigest: fact.sourceEvidenceSemanticDigest,
    ordering: {
      scopeEpoch: fact.scopeEpoch,
      observedAt: fact.observedAt,
      recordedAt: fact.provenance.recordedAt,
      sourceRank: fact.sourceRank,
      confidenceMillionths: Math.round(fact.confidence * 1_000_000),
      taskVersion: fact.provenance.evidenceTaskVersion,
      objectiveRevision: fact.provenance.objectiveRevision,
      planVersion: fact.provenance.planVersion,
      taskDigest: governorDigest({ taskId: fact.provenance.evidenceTaskId }),
    },
  });
  if (fact.authorityBindingDigest !== expectedBinding) {
    throw new Error("governor memory authority binding is invalid");
  }
  const normalized: MemoryGovernorFact = {
    ...fact,
    memoryId: text(fact.memoryId, "memoryId", 256),
    scopeKey,
    factKey,
    subject: text(fact.subject, "subject", 256),
    predicate: text(fact.predicate, "predicate", 256),
    object: text(fact.object, "object", 2048),
    text: text(fact.text, "text", 4096),
    sourceIdentity: text(fact.sourceIdentity, "sourceIdentity", 512),
    sourceEvidenceId: text(fact.sourceEvidenceId, "sourceEvidenceId", 512),
    sourceEvidenceDigest: text(fact.sourceEvidenceDigest, "sourceEvidenceDigest", 256),
    sourceEvidenceSemanticDigest: text(
      fact.sourceEvidenceSemanticDigest,
      "sourceEvidenceSemanticDigest",
      256,
    ),
    confidence: unit(fact.confidence, "confidence"),
    authority: unit(fact.authority, "authority"),
    observedAt: timestamp(fact.observedAt, "observedAt"),
    ...(fact.freshnessExpiresAt === undefined
      ? {}
      : { freshnessExpiresAt: timestamp(fact.freshnessExpiresAt, "freshnessExpiresAt") }),
    sourceEvidenceLineage: lineage(fact.sourceEvidenceLineage, "sourceEvidenceLineage"),
    sourceMemoryLineage: lineage(fact.sourceMemoryLineage, "sourceMemoryLineage"),
  };
  if (
    normalized.freshnessExpiresAt !== undefined &&
    normalized.freshnessExpiresAt < normalized.observedAt
  ) {
    throw new Error("governor memory freshnessExpiresAt is older than observedAt");
  }
  assertMemoryContentSafe(normalized.text);
  return normalized;
}

export function parseGovernorFact(row: GovernorLedgerSqlRow): Optional<MemoryGovernorFact> {
  try {
    const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    const governor = metadata.governor;
    if (!governor || typeof governor !== "object" || Array.isArray(governor)) {
      return undefined;
    }
    const value = governor as Record<string, unknown>;
    const fact: MemoryGovernorFact = {
      memoryId: String(row.revision_id),
      agentId: String(row.agent_id),
      scope: String(row.scope),
      scopeKey: String(value.scopeKey ?? row.scope),
      scopeEpoch: Number(value.scopeEpoch ?? 0),
      factKey: String(row.fact_key),
      subject: String(row.subject),
      predicate: String(row.predicate),
      object: String(row.object_value),
      text: String(row.text),
      category: String(row.category),
      content: value.content,
      contentDigest: String(value.contentDigest),
      status: "verified",
      sourceKind: value.sourceKind as MemoryGovernorFact["sourceKind"],
      confidence: Number(row.confidence),
      authority: Number(row.authority),
      generation: Number(value.generation ?? 0),
      sensitivity: value.sensitivity === "sensitive" ? "sensitive" : "normal",
      observedAt: Number(row.observed_at),
      ...(value.freshnessExpiresAt === undefined
        ? {}
        : { freshnessExpiresAt: Number(value.freshnessExpiresAt) }),
      sourceIdentity: String(value.sourceIdentity),
      sourceRank: Number(value.sourceRank),
      sourceEvidenceId: String(value.sourceEvidenceId),
      sourceEvidenceDigest: String(value.sourceEvidenceDigest),
      sourceEvidenceSemanticDigest: String(value.sourceEvidenceSemanticDigest),
      authorityBindingDigest: String(value.authorityBindingDigest),
      provenance: value.provenance as MemoryGovernorFact["provenance"],
      ...(Array.isArray(value.sourceEvidenceLineage)
        ? { sourceEvidenceLineage: value.sourceEvidenceLineage.map(String) }
        : {}),
      ...(Array.isArray(value.sourceMemoryLineage)
        ? { sourceMemoryLineage: value.sourceMemoryLineage.map(String) }
        : {}),
    };
    return normalizeGovernorFact(fact);
  } catch {
    return undefined;
  }
}
