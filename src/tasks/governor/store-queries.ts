// Read-side queries kept separate from the transactional governor projection store.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import {
  governorDb,
  parseEffectRow,
  parseEventRow,
  parseEvidenceRow,
  parseTaskRow,
} from "./store-codec.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function loadGovernorTask(
  db: DatabaseSync,
  taskId: GovernorTaskId,
): GovernorTaskProjection | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    governorDb(db).selectFrom("governor_tasks").selectAll().where("task_id", "=", taskId),
  );
  return row ? parseTaskRow(row) : null;
}

export function loadGovernorEvidence(
  db: DatabaseSync,
  taskId: GovernorTaskId,
  evidenceId: string,
  verifyEvidence: (evidence: GovernorEvidenceRecord) => void,
): GovernorEvidenceRecord | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    governorDb(db)
      .selectFrom("governor_evidence")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("evidence_id", "=", evidenceId),
  );
  return row ? parseEvidenceRow(row, verifyEvidence) : null;
}

export class GovernorStoreQueries {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #verifyEvidence: (evidence: GovernorEvidenceRecord) => void;

  constructor(
    options: OpenClawStateDatabaseOptions,
    verifyEvidence: (evidence: GovernorEvidenceRecord) => void,
  ) {
    this.#options = options;
    this.#verifyEvidence = verifyEvidence;
  }

  loadTask(taskId: GovernorTaskId): GovernorTaskProjection | null {
    return loadGovernorTask(openOpenClawStateDatabase(this.#options).db, taskId);
  }

  listEvents(taskId: GovernorTaskId): GovernorEventRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_events")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("event_id", "asc"),
    ).rows.map(parseEventRow);
  }

  listEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseEffectRow);
  }

  loadEffect(taskId: GovernorTaskId, effectId: string): GovernorEffectRecord | null {
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("effect_id", "=", effectId),
    );
    return row ? parseEffectRow(row) : null;
  }

  listEvidence(taskId: GovernorTaskId): GovernorEvidenceRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("evidence_id", "asc"),
    ).rows.map((row) => parseEvidenceRow(row, this.#verifyEvidence));
  }

  loadEvidence(taskId: GovernorTaskId, evidenceId: string): GovernorEvidenceRecord | null {
    return loadGovernorEvidence(
      openOpenClawStateDatabase(this.#options).db,
      taskId,
      evidenceId,
      this.#verifyEvidence,
    );
  }

  listUnfinishedFanoutJobIds(task: GovernorTaskProjection): string[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_fanout_jobs")
        .select(["job_id"])
        .where("task_id", "=", task.taskId)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .where("state", "in", ["queued", "running"])
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows.map((row) => row.job_id);
  }
}
