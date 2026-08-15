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
        `SELECT source_memory_id FROM memory_governor_lineage WHERE memory_id IN (${placeholders}) AND source_memory_id IS NOT NULL LIMIT 256`,
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
  max = 256,
): readonly string[] {
  const descendants = new Set<string>();
  let frontier = [memoryId];
  while (frontier.length > 0 && descendants.size < max) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT memory_id FROM memory_governor_lineage WHERE source_memory_id IN (${placeholders}) LIMIT ${max}`,
      )
      .all(...frontier) as SqlRow[];
    frontier = [];
    for (const row of rows) {
      const child = String(row.memory_id);
      if (child !== memoryId && !descendants.has(child)) {
        descendants.add(child);
        frontier.push(child);
      }
    }
  }
  return [...descendants];
}
