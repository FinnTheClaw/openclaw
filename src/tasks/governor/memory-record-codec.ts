import type { Insertable, Selectable } from "kysely";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { canonicalGovernorJson, governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { isOpaqueEvidenceSourceRef } from "./evidence.js";
import { failGovernorIntegrity, parseGovernorStoredJson } from "./integrity-error.js";
import { governorMemoryAuthorityBindingDigest } from "./memory-authority-binding.js";
import type {
  GovernorMemoryProvenance,
  GovernorMemoryRecord,
  GovernorMemorySourceKind,
  GovernorMemoryStatus,
} from "./memory-types.js";
import { normalizeGovernorFactKey } from "./memory-types.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";

export type GovernorMemoryRow = Selectable<OpenClawStateKyselyDatabase["governor_memories"]>;
type GovernorScopeEpochRow = Selectable<OpenClawStateKyselyDatabase["governor_scope_epochs"]>;

const MEMORY_STATUSES = new Set<GovernorMemoryStatus>([
  "candidate",
  "verified",
  "quarantined",
  "superseded",
  "tombstoned",
]);
const MEMORY_SOURCE_KINDS = new Set<GovernorMemorySourceKind>([
  "structured_external",
  "authenticated_user",
  "tool",
  "historical_memory",
  "untrusted_candidate",
  "assistant_text",
  "hidden_reasoning",
]);
const PROVENANCE_KEYS = new Set([
  "sourceRef",
  "observedAt",
  "recordedAt",
  "scopeKey",
  "confidence",
  "sensitivity",
  "evidenceTaskId",
  "evidenceTaskVersion",
  "objectiveRevision",
  "planVersion",
]);

export function parseGovernorScopeEpoch(row: GovernorScopeEpochRow | undefined): number {
  return row ? (normalizeSqliteNumber(row.epoch) ?? 0) : 0;
}

function parseCanonicalStoredJson(raw: string, code: string): GovernorJsonValue {
  const parsed = parseGovernorStoredJson(raw, "memory", code);
  if (canonicalGovernorJson(parsed) !== raw) {
    return failGovernorIntegrity(code);
  }
  return parsed;
}

function isSafeTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates canonical row content before it can be persisted, authorized, or recalled. */
export function assertCanonicalGovernorMemoryRecord(
  memory: GovernorMemoryRecord,
): GovernorMemoryRecord {
  assertGovernorPersistedJson("memory", memory);
  const provenance = memory.provenance;
  if (
    !memory.memoryId ||
    !memory.scopeKey ||
    !memory.factKey ||
    normalizeGovernorFactKey(memory.factKey) !== memory.factKey ||
    !MEMORY_STATUSES.has(memory.status) ||
    !MEMORY_SOURCE_KINDS.has(memory.sourceKind) ||
    !Number.isSafeInteger(memory.scopeEpoch) ||
    memory.scopeEpoch < 0 ||
    !Number.isSafeInteger(memory.sourceRank) ||
    memory.sourceRank < 0 ||
    !isSafeTime(memory.observedAt) ||
    !isSafeTime(memory.createdAt) ||
    !isSafeTime(memory.updatedAt) ||
    (memory.freshnessExpiresAt !== undefined && !isSafeTime(memory.freshnessExpiresAt)) ||
    (memory.tombstonedAt !== undefined && !isSafeTime(memory.tombstonedAt)) ||
    typeof memory.confidence !== "number" ||
    !Number.isFinite(memory.confidence) ||
    memory.confidence < 0 ||
    memory.confidence > 1 ||
    !provenance ||
    Object.keys(provenance).some((key) => !PROVENANCE_KEYS.has(key)) ||
    typeof provenance.sourceRef !== "string" ||
    !provenance.sourceRef ||
    provenance.scopeKey !== memory.scopeKey ||
    provenance.observedAt !== memory.observedAt ||
    provenance.confidence !== memory.confidence ||
    provenance.sensitivity !== memory.sensitivity ||
    !isSafeTime(provenance.recordedAt) ||
    governorDigest(memory.content) !== memory.contentDigest
  ) {
    return failGovernorIntegrity("GOVERNOR_MEMORY_CANONICAL_BINDING_INVALID");
  }
  if (
    memory.status === "verified" &&
    (!memory.verifiedEvidenceTaskId ||
      !memory.verifiedEvidenceId ||
      !memory.verifiedEvidenceDigest ||
      !memory.verifiedEvidenceSemanticDigest ||
      provenance.evidenceTaskId !== memory.verifiedEvidenceTaskId ||
      !isSafeTime(provenance.evidenceTaskVersion) ||
      !isSafeTime(provenance.objectiveRevision) ||
      !isSafeTime(provenance.planVersion))
  ) {
    return failGovernorIntegrity("GOVERNOR_MEMORY_VERIFIED_BINDING_INVALID");
  }
  const hasAuthority =
    memory.authorityGeneration !== undefined || memory.authorityBindingDigest !== undefined;
  let authorityDigestMatches = false;
  if (hasAuthority && memory.authorityBindingDigest) {
    try {
      authorityDigestMatches =
        memory.authorityBindingDigest === governorMemoryAuthorityBindingDigest(memory);
    } catch {
      authorityDigestMatches = false;
    }
  }
  if (
    hasAuthority &&
    (!Number.isSafeInteger(memory.authorityGeneration) ||
      (memory.authorityGeneration ?? 0) < 0 ||
      !memory.authorityBindingDigest ||
      !authorityDigestMatches)
  ) {
    return failGovernorIntegrity("GOVERNOR_MEMORY_AUTHORITY_BINDING_INVALID");
  }
  return memory;
}

export function parseGovernorMemory(row: GovernorMemoryRow): GovernorMemoryRecord {
  const memory: GovernorMemoryRecord = {
    memoryId: row.memory_id,
    scopeKey: row.scope_key,
    scopeEpoch: normalizeSqliteNumber(row.scope_epoch) ?? 0,
    factKey: row.fact_key,
    status: row.status as GovernorMemoryStatus,
    sourceKind: row.source_kind as GovernorMemorySourceKind,
    sourceIdentity: row.source_identity,
    sourceRank: normalizeSqliteNumber(row.source_rank) ?? 0,
    observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
    ...(row.freshness_expires_at == null
      ? {}
      : { freshnessExpiresAt: normalizeSqliteNumber(row.freshness_expires_at) ?? 0 }),
    confidence: row.confidence,
    sensitivity: row.sensitivity as GovernorMemoryRecord["sensitivity"],
    provenance: parseCanonicalStoredJson(
      row.provenance_json,
      "GOVERNOR_MEMORY_PROVENANCE_INVALID",
    ) as unknown as GovernorMemoryProvenance,
    content: parseCanonicalStoredJson(row.content_json, "GOVERNOR_MEMORY_CONTENT_INVALID"),
    contentDigest: row.content_digest,
    ...(row.verified_evidence_task_id
      ? { verifiedEvidenceTaskId: row.verified_evidence_task_id }
      : {}),
    ...(row.verified_evidence_id ? { verifiedEvidenceId: row.verified_evidence_id } : {}),
    ...(row.verified_evidence_digest
      ? { verifiedEvidenceDigest: row.verified_evidence_digest }
      : {}),
    ...(row.verified_evidence_semantic_digest
      ? { verifiedEvidenceSemanticDigest: row.verified_evidence_semantic_digest }
      : {}),
    ...(row.authority_generation == null
      ? {}
      : { authorityGeneration: normalizeSqliteNumber(row.authority_generation) ?? 0 }),
    ...(row.authority_binding_digest
      ? { authorityBindingDigest: row.authority_binding_digest }
      : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    ...(row.superseded_at == null
      ? {}
      : { supersededAt: normalizeSqliteNumber(row.superseded_at) ?? 0 }),
    ...(row.superseded_evidence_id ? { supersededEvidenceId: row.superseded_evidence_id } : {}),
    ...(row.superseded_evidence_digest
      ? { supersededEvidenceDigest: row.superseded_evidence_digest }
      : {}),
    ...(row.superseded_reason ? { supersededReason: row.superseded_reason } : {}),
    ...(row.contradiction_fingerprint
      ? { contradictionFingerprint: row.contradiction_fingerprint }
      : {}),
    ...(row.replacement_memory_id ? { replacementMemoryId: row.replacement_memory_id } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(row.tombstoned_at == null
      ? {}
      : { tombstonedAt: normalizeSqliteNumber(row.tombstoned_at) ?? 0 }),
  };
  return assertCanonicalGovernorMemoryRecord(memory);
}

/** Returns only bounded audit metadata when a persisted record cannot be authenticated. */
export function parseGovernorMemoryAudit(row: GovernorMemoryRow): GovernorMemoryRecord {
  try {
    return parseGovernorMemory(row);
  } catch {
    const content = { quarantined: true } as const;
    return {
      memoryId: row.memory_id,
      scopeKey: row.scope_key,
      scopeEpoch: normalizeSqliteNumber(row.scope_epoch) ?? 0,
      factKey: row.fact_key,
      status: "quarantined",
      sourceKind: "historical_memory",
      sourceIdentity: "quarantined",
      sourceRank: 0,
      observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
      confidence: 0,
      sensitivity: "normal",
      provenance: {
        sourceRef: "quarantined",
        observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
        recordedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
        scopeKey: row.scope_key,
        confidence: 0,
        sensitivity: "normal",
      },
      content,
      contentDigest: governorDigest(content),
      createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
      updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    };
  }
}

export function bindGovernorMemory(memory: GovernorMemoryRecord): Insertable<GovernorMemoryRow> {
  assertCanonicalGovernorMemoryRecord(memory);
  if (
    memory.status === "verified" &&
    (!isOpaqueEvidenceSourceRef(memory.sourceIdentity) ||
      !isOpaqueEvidenceSourceRef(memory.provenance.sourceRef))
  ) {
    throw new Error("Governor verified memory source identity is not opaque");
  }
  return {
    memory_id: memory.memoryId,
    scope_key: memory.scopeKey,
    scope_epoch: memory.scopeEpoch,
    fact_key: memory.factKey,
    status: memory.status,
    source_kind: memory.sourceKind,
    source_identity: memory.sourceIdentity,
    source_rank: memory.sourceRank,
    observed_at: memory.observedAt,
    freshness_expires_at: memory.freshnessExpiresAt ?? null,
    confidence: memory.confidence,
    sensitivity: memory.sensitivity,
    provenance_json: canonicalGovernorJson(memory.provenance as unknown as GovernorJsonValue),
    content_json: canonicalGovernorJson(memory.content),
    content_digest: memory.contentDigest,
    verified_evidence_task_id: memory.verifiedEvidenceTaskId ?? null,
    verified_evidence_id: memory.verifiedEvidenceId ?? null,
    verified_evidence_digest: memory.verifiedEvidenceDigest ?? null,
    verified_evidence_semantic_digest: memory.verifiedEvidenceSemanticDigest ?? null,
    authority_generation: memory.authorityGeneration ?? null,
    authority_binding_digest: memory.authorityBindingDigest ?? null,
    supersedes_id: memory.supersedesId ?? null,
    superseded_at: memory.supersededAt ?? null,
    superseded_evidence_id: memory.supersededEvidenceId ?? null,
    superseded_evidence_digest: memory.supersededEvidenceDigest ?? null,
    superseded_reason: memory.supersededReason ?? null,
    contradiction_fingerprint: memory.contradictionFingerprint ?? null,
    replacement_memory_id: memory.replacementMemoryId ?? null,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    tombstoned_at: memory.tombstonedAt ?? null,
  };
}
