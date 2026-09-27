import type { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, unknown>;

export function assertNoGovernorLineageCycle(
  db: DatabaseSync,
  memoryId: string,
  parents: readonly string[],
): void {
  const seen = new Set<string>();
  let frontier = [...parents];
  while (frontier.length > 0 && seen.size < 256) {
    if (frontier.includes(memoryId)) {
      throw new Error("GOVERNOR_MEMORY_LINEAGE_CYCLE");
    }
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT source_memory_id FROM memory_governor_lineage WHERE relation_kind = 'memory' AND memory_id IN (${placeholders}) LIMIT 256`,
      )
      .all(...frontier) as SqlRow[];
    frontier = [];
    for (const row of rows) {
      const parent = String(row.source_memory_id);
      if (!seen.has(parent)) {
        seen.add(parent);
        frontier.push(parent);
      }
    }
  }
  if (seen.size >= 256) {
    throw new Error("GOVERNOR_MEMORY_LINEAGE_TOO_DEEP");
  }
}

export function findGovernorLineageDescendants(
  db: DatabaseSync,
  memoryId: string,
  scopeKey: string,
  sourceEvidenceIds: readonly string[] = [],
  max = 256,
): readonly string[] {
  const descendants = new Set<string>();
  let frontier = [memoryId];
  let pendingSourceEvidenceIds = [...new Set(sourceEvidenceIds.filter(Boolean))];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => "?").join(", ");
    const evidencePlaceholders = pendingSourceEvidenceIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT DISTINCT memory_id FROM memory_governor_lineage WHERE scope_key = ? AND ((relation_kind = 'memory' AND source_memory_id IN (${placeholders})) OR (relation_kind = 'evidence' AND ${evidencePlaceholders ? `source_evidence_id IN (${evidencePlaceholders})` : "0"})) LIMIT ${max + 1}`,
      )
      .all(scopeKey, ...frontier, ...pendingSourceEvidenceIds) as SqlRow[];
    frontier = [];
    for (const row of rows) {
      const child = String(row.memory_id);
      if (child !== memoryId && !descendants.has(child)) {
        if (descendants.size >= max) {
          throw new Error("GOVERNOR_MEMORY_LINEAGE_TOO_LARGE");
        }
        descendants.add(child);
        frontier.push(child);
        const lineageRows = db
          .prepare(
            "SELECT DISTINCT source_evidence_id FROM memory_governor_lineage " +
              "WHERE scope_key = ? AND memory_id = ? AND source_evidence_id != ''",
          )
          .all(scopeKey, child) as SqlRow[];
        for (const lineageRow of lineageRows) {
          const sourceEvidenceId = String(lineageRow.source_evidence_id);
          if (sourceEvidenceId) {
            pendingSourceEvidenceIds.push(sourceEvidenceId);
          }
        }
      }
    }
    pendingSourceEvidenceIds = [...new Set(pendingSourceEvidenceIds)];
  }
  return [...descendants];
}
