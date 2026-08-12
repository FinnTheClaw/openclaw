// Reads remediation projections outside the mutation-focused contradiction store.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  parseGovernorMemoryRemediation,
  type GovernorMemoryRemediation,
} from "./memory-remediation.js";

type RemediationDatabase = Pick<OpenClawStateKyselyDatabase, "governor_memory_remediations">;

export function listGovernorMemoryRemediations(
  db: DatabaseSync,
  scopeKey: string,
): GovernorMemoryRemediation[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<RemediationDatabase>(db)
      .selectFrom("governor_memory_remediations")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .orderBy("created_at", "asc")
      .orderBy("contradiction_fingerprint", "asc"),
  ).rows.map(parseGovernorMemoryRemediation);
}
