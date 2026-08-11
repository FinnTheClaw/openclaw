import type { Insertable, Selectable } from "kysely";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import type {
  GovernorMemoryProvenance,
  GovernorMemoryRecord,
  GovernorMemorySourceKind,
  GovernorMemoryStatus,
} from "./memory-types.js";

export type GovernorMemoryRow = Selectable<OpenClawStateKyselyDatabase["governor_memories"]>;

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid governor memory ${label}`, { cause: error });
  }
}

export function parseGovernorMemory(row: GovernorMemoryRow): GovernorMemoryRecord {
  return {
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
    provenance: parseJson(row.provenance_json, "provenance") as GovernorMemoryProvenance,
    content: parseJson(row.content_json, "content") as GovernorJsonValue,
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
}

export function bindGovernorMemory(memory: GovernorMemoryRecord): Insertable<GovernorMemoryRow> {
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
    provenance_json: JSON.stringify(memory.provenance),
    content_json: JSON.stringify(memory.content),
    content_digest: memory.contentDigest,
    verified_evidence_task_id: memory.verifiedEvidenceTaskId ?? null,
    verified_evidence_id: memory.verifiedEvidenceId ?? null,
    verified_evidence_digest: memory.verifiedEvidenceDigest ?? null,
    verified_evidence_semantic_digest: memory.verifiedEvidenceSemanticDigest ?? null,
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
