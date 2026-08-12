// Resolves the authoritative memory scope epoch inside an existing SQLite transaction.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { parseGovernorScopeEpoch } from "./memory-record-codec.js";

type ScopeEpochDatabase = Pick<OpenClawStateKyselyDatabase, "governor_scope_epochs">;

export function loadCurrentGovernorMemoryScopeEpoch(db: DatabaseSync, scopeKey: string): number {
  return parseGovernorScopeEpoch(
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<ScopeEpochDatabase>(db)
        .selectFrom("governor_scope_epochs")
        .selectAll()
        .where("scope_key", "=", scopeKey),
    ),
  );
}
