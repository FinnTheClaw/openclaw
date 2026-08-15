import type { DatabaseSync } from "node:sqlite";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type SqlRow = Record<string, unknown>;
type Optional<T> = T | undefined;

export function listCurrentGovernorFacts(
  db: DatabaseSync,
  agentId: string,
  scopes: readonly string[],
  now: number,
  parse: (row: SqlRow) => Optional<MemoryGovernorFact>,
): MemoryGovernorFact[] {
  const placeholders = scopes.map(() => "?").join(", ");
  if (!placeholders) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT * FROM memory_fact_revisions WHERE agent_id = ? AND scope IN (${placeholders}) ` +
        "AND status = 'active' AND system_to IS NULL ORDER BY authority DESC, confidence DESC LIMIT 200",
    )
    .all(agentId, ...scopes) as SqlRow[];
  return rows
    .map(parse)
    .filter((fact): fact is MemoryGovernorFact => Boolean(fact))
    .filter((fact) => fact.freshnessExpiresAt === undefined || fact.freshnessExpiresAt > now);
}
