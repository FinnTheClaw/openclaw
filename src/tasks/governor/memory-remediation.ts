// Durable contradiction/remediation receipts for scoped governor memory.
import type { Insertable, Selectable } from "kysely";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorTaskId } from "./types.js";

type GovernorMemoryRemediationRow = Selectable<
  OpenClawStateKyselyDatabase["governor_memory_remediations"]
>;

export type GovernorMemoryRemediationStatus =
  | "unresolved"
  | "queued"
  | "repairing"
  | "blocked"
  | "verified";

export type GovernorMemoryRemediation = {
  contradictionFingerprint: string;
  scopeKey: string;
  factKey: string;
  contradictionClass: string;
  canonicalSourceRef: string;
  staleMemoryId: string;
  replacementMemoryId?: string;
  evidenceId: string;
  evidenceDigest: string;
  evidenceObservedAt: number;
  status: GovernorMemoryRemediationStatus;
  taskId: GovernorTaskId;
  repairEffectId?: string;
  blockedReason?: string;
  investigationCount: number;
  verificationEvidenceId?: string;
  verificationEvidenceDigest?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

export function parseGovernorMemoryRemediation(
  row: GovernorMemoryRemediationRow,
): GovernorMemoryRemediation {
  const remediation: GovernorMemoryRemediation = {
    contradictionFingerprint: row.contradiction_fingerprint,
    scopeKey: row.scope_key,
    factKey: row.fact_key,
    contradictionClass: row.contradiction_class,
    canonicalSourceRef: row.canonical_source_ref,
    staleMemoryId: row.stale_memory_id,
    ...(row.replacement_memory_id ? { replacementMemoryId: row.replacement_memory_id } : {}),
    evidenceId: row.evidence_id,
    evidenceDigest: row.evidence_digest,
    evidenceObservedAt: normalizeSqliteNumber(row.evidence_observed_at) ?? 0,
    status: row.status as GovernorMemoryRemediationStatus,
    taskId: row.task_id as GovernorTaskId,
    ...(row.repair_effect_id ? { repairEffectId: row.repair_effect_id } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    investigationCount: normalizeSqliteNumber(row.investigation_count) ?? 0,
    ...(row.verification_evidence_id
      ? { verificationEvidenceId: row.verification_evidence_id }
      : {}),
    ...(row.verification_evidence_digest
      ? { verificationEvidenceDigest: row.verification_evidence_digest }
      : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(row.closed_at == null ? {} : { closedAt: normalizeSqliteNumber(row.closed_at) ?? 0 }),
  };
  assertGovernorPersistedJson("log", remediation);
  return remediation;
}

export function bindGovernorMemoryRemediation(
  remediation: GovernorMemoryRemediation,
): Insertable<GovernorMemoryRemediationRow> {
  assertGovernorPersistedJson("log", remediation);
  return {
    contradiction_fingerprint: remediation.contradictionFingerprint,
    scope_key: remediation.scopeKey,
    fact_key: remediation.factKey,
    contradiction_class: remediation.contradictionClass,
    canonical_source_ref: remediation.canonicalSourceRef,
    stale_memory_id: remediation.staleMemoryId,
    replacement_memory_id: remediation.replacementMemoryId ?? null,
    evidence_id: remediation.evidenceId,
    evidence_digest: remediation.evidenceDigest,
    evidence_observed_at: remediation.evidenceObservedAt,
    status: remediation.status,
    task_id: remediation.taskId,
    repair_effect_id: remediation.repairEffectId ?? null,
    blocked_reason: remediation.blockedReason ?? null,
    investigation_count: remediation.investigationCount,
    verification_evidence_id: remediation.verificationEvidenceId ?? null,
    verification_evidence_digest: remediation.verificationEvidenceDigest ?? null,
    created_at: remediation.createdAt,
    updated_at: remediation.updatedAt,
    closed_at: remediation.closedAt ?? null,
  };
}
