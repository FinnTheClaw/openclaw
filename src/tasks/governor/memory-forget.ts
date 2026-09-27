import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import { bindGovernorMemory, parseGovernorMemory } from "./memory-record-codec.js";
import { loadCurrentGovernorMemoryScopeEpoch } from "./memory-scope-epoch.js";
import type { GovernorForgetResult, GovernorMemoryRecord } from "./memory-types.js";

type ForgetDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_scope_epochs"
>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<ForgetDatabase>(db);

export function forgetGovernorMemory(params: {
  options: OpenClawStateDatabaseOptions;
  authority: GovernorMemoryAuthorityStore;
  scopeKey: string;
  memoryId: string;
  expectedScopeEpoch: number;
  now: number;
}): GovernorForgetResult {
  return runOpenClawStateWriteTransaction<GovernorForgetResult>(({ db }) => {
    const currentEpoch = loadCurrentGovernorMemoryScopeEpoch(db, params.scopeKey);
    if (currentEpoch !== params.expectedScopeEpoch) {
      return {
        status: "partial_failure",
        memoryId: params.memoryId,
        scopeEpoch: currentEpoch,
        failed: ["scope_epoch_conflict"],
      };
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_memories")
        .selectAll()
        .where("memory_id", "=", params.memoryId)
        .where("scope_key", "=", params.scopeKey)
        .where("status", "!=", "tombstoned"),
    );
    if (!row) {
      return { status: "not_found", memoryId: params.memoryId, scopeEpoch: currentEpoch };
    }
    const currentMemory = parseGovernorMemory(row);
    if (currentMemory.status === "verified") {
      const authorityState = params.authority.state(currentMemory);
      if (authorityState === "current" || authorityState === "legacy") {
        params.authority.retire(currentMemory, {
          reason: "explicit_forget",
          semanticCutoff: params.now,
          issuedAt: params.now,
        });
      }
    }
    const nextEpoch = currentEpoch + 1;
    const memory: GovernorMemoryRecord = {
      ...currentMemory,
      status: "tombstoned",
      updatedAt: params.now,
      tombstonedAt: params.now,
    };
    executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_memories")
        .set(bindGovernorMemory(memory))
        .where("memory_id", "=", params.memoryId)
        .where("scope_key", "=", params.scopeKey),
    );
    executeSqliteQuerySync(
      db,
      dbx(db)
        .insertInto("governor_scope_epochs")
        .values({ scope_key: params.scopeKey, epoch: nextEpoch, updated_at: params.now })
        .onConflict((conflict) =>
          conflict.column("scope_key").doUpdateSet({
            epoch: nextEpoch,
            updated_at: params.now,
          }),
        ),
    );
    return {
      status: "deleted",
      memoryId: params.memoryId,
      scopeEpoch: nextEpoch,
      invalidated: ["primary", "scope_epoch"],
    };
  }, params.options);
}
