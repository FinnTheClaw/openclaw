import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest } from "./canonical-json.js";
import type { GovernorEventRecord } from "./events.js";
import { assertGovernorPersistedJson, assertSameGovernorScope } from "./persistence-guard.js";
import { bindEvent, governorDb, parseTaskRow } from "./store-codec.js";
import type { GovernorTaskProjection } from "./types.js";

export function appendGovernorAuditEvent(params: {
  options: OpenClawStateDatabaseOptions;
  task: GovernorTaskProjection;
  event: GovernorEventRecord;
}): boolean {
  assertGovernorPersistedJson("log", { task: params.task, event: params.event });
  assertSameGovernorScope(params.task, params.task);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db)
        .selectFrom("governor_tasks")
        .selectAll()
        .where("task_id", "=", params.task.taskId),
    );
    if (
      !row ||
      row.task_version !== params.task.taskVersion ||
      row.lease_epoch !== params.task.leaseEpoch ||
      params.event.taskId !== params.task.taskId ||
      params.event.scopeKey !== params.task.scopeKey ||
      params.event.taskVersion !== params.task.taskVersion ||
      params.event.objectiveRevision !== params.task.objectiveRevision ||
      params.event.payloadDigest !== governorDigest(params.event.payload)
    ) {
      return false;
    }
    assertSameGovernorScope(parseTaskRow(row), params.task);
    executeSqliteQuerySync(
      db,
      governorDb(db).insertInto("governor_events").values(bindEvent(params.event)),
    );
    return true;
  }, params.options);
}
