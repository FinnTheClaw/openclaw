import type { GovernorEvidenceRecord } from "./evidence.js";
import type { GovernorTaskProjection } from "./types.js";

/** Validates the host-owned immutable evidence ancestry before a plan carry-forward. */
export function assertGovernorEvidenceLineage(params: {
  source: GovernorEvidenceRecord;
  task: GovernorTaskProjection;
  records: readonly GovernorEvidenceRecord[];
}): void {
  const records = new Map(params.records.map((record) => [record.evidenceId, record]));
  const persisted = records.get(params.source.evidenceId);
  if (
    !persisted ||
    persisted.taskId !== params.source.taskId ||
    persisted.evidenceDigest !== params.source.evidenceDigest ||
    persisted.admissionSignature !== params.source.admissionSignature
  ) {
    throw new Error("GOVERNOR_EVIDENCE_LINEAGE_SOURCE_MISMATCH");
  }
  if (
    params.source.taskId !== params.task.taskId ||
    params.source.scopeKey !== params.task.scopeKey
  ) {
    throw new Error("GOVERNOR_EVIDENCE_LINEAGE_TASK_MISMATCH");
  }
  const visited = new Set<string>();
  let current: GovernorEvidenceRecord | undefined = params.source;
  while (current?.sourceEvidenceId) {
    if (visited.has(current.evidenceId) || current.sourceEvidenceId === current.evidenceId) {
      throw new Error("GOVERNOR_EVIDENCE_LINEAGE_CYCLE");
    }
    visited.add(current.evidenceId);
    const parent = records.get(current.sourceEvidenceId);
    if (
      !parent ||
      parent.taskId !== params.task.taskId ||
      parent.scopeKey !== params.task.scopeKey
    ) {
      throw new Error("GOVERNOR_EVIDENCE_LINEAGE_SOURCE_MISMATCH");
    }
    if (parent.planVersion >= current.planVersion || parent.createdAt > current.createdAt) {
      throw new Error("GOVERNOR_EVIDENCE_LINEAGE_ORDER_INVALID");
    }
    current = parent;
  }
}
