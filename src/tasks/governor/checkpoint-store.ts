// Persists evidence-bound progress and replan checkpoints for restart continuity.
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId } from "./types.js";

type CheckpointDatabase = Pick<OpenClawStateKyselyDatabase, "governor_checkpoints">;
type GovernorCheckpointRow = Selectable<OpenClawStateKyselyDatabase["governor_checkpoints"]>;

export function bindGovernorCheckpoint(
  checkpoint: GovernorCheckpoint,
): Insertable<GovernorCheckpointRow> {
  return {
    checkpoint_id: checkpoint.checkpointId,
    task_id: checkpoint.taskId,
    task_version: checkpoint.taskVersion,
    objective_revision: checkpoint.objectiveRevision,
    plan_version: checkpoint.planVersion,
    checkpoint_json: JSON.stringify(checkpoint),
    checkpoint_digest: governorDigest(checkpoint as unknown as GovernorJsonValue),
    created_at: checkpoint.createdAt,
  };
}

function parseCheckpoint(row: GovernorCheckpointRow): GovernorCheckpoint {
  let checkpoint: GovernorCheckpoint;
  try {
    checkpoint = JSON.parse(row.checkpoint_json) as GovernorCheckpoint;
  } catch (error) {
    throw new Error(`Invalid persisted governor checkpoint ${row.checkpoint_id}`, { cause: error });
  }
  if (
    checkpoint.checkpointId !== row.checkpoint_id ||
    checkpoint.taskId !== row.task_id ||
    governorDigest(checkpoint as unknown as GovernorJsonValue) !== row.checkpoint_digest
  ) {
    throw new Error(`Persisted governor checkpoint mismatch for ${row.checkpoint_id}`);
  }
  return checkpoint;
}

export class GovernorCheckpointStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string; options?: OpenClawStateDatabaseOptions } = {}) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    initializeGovernorStateSchema(this.#options);
  }

  list(taskId: GovernorTaskId): GovernorCheckpoint[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CheckpointDatabase>(db)
        .selectFrom("governor_checkpoints")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("checkpoint_id", "asc"),
    ).rows.map(parseCheckpoint);
  }
}
