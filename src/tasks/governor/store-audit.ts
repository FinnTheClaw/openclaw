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
import { bindEvent, governorDb } from "./store-codec.js";
import type { GovernorTaskProjection } from "./types.js";

export function appendGovernorAuditEvent(params: {
  options: OpenClawStateDatabaseOptions;
  task: GovernorTaskProjection;
  event: GovernorEventRecord;
}): boolean {
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
      Number(row.task_version) !== params.task.taskVersion ||
      Number(row.lease_epoch) !== params.task.leaseEpoch ||
      params.event.taskId !== params.task.taskId ||
      params.event.taskVersion !== params.task.taskVersion ||
      params.event.objectiveRevision !== params.task.objectiveRevision ||
      params.event.payloadDigest !== governorDigest(params.event.payload)
    )
      return false;
    executeSqliteQuerySync(
      db,
      governorDb(db).insertInto("governor_events").values(bindEvent(params.event)),
    );
    return true;
  }, params.options);
}
