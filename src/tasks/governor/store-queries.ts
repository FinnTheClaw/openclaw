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
import { governorDb, parseEffectRow, parseEventRow, parseEvidenceRow } from "./store-codec.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function loadGovernorTask(
  db: DatabaseSync,
  taskId: GovernorTaskId,
  tasks: GovernorTaskAuthorityStore,
): GovernorTaskProjection | null {
  return tasks.loadCurrent(db, taskId);
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
  readonly #tasks: GovernorTaskAuthorityStore;

  constructor(
    options: OpenClawStateDatabaseOptions,
    tasks: GovernorTaskAuthorityStore,
    verifyEvidence: (evidence: GovernorEvidenceRecord) => void,
  ) {
    this.#options = options;
    this.#tasks = tasks;
    this.#verifyEvidence = verifyEvidence;
  }

  loadTask(taskId: GovernorTaskId): GovernorTaskProjection | null {
    return loadGovernorTask(openOpenClawStateDatabase(this.#options).db, taskId, this.#tasks);
  }

  listEvents(taskId: GovernorTaskId): GovernorEventRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    if (!loadGovernorTask(db, taskId, this.#tasks)) {
      return [];
    }
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

  findTaskForAuthenticatedSource(
    scopeKey: string,
    sourceMessageId: string,
  ): GovernorTaskProjection | null {
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db)
        .selectFrom("governor_events")
        .select("task_id")
        .where("scope_key", "=", scopeKey)
        .where("source_message_id", "=", sourceMessageId)
        .orderBy("created_at", "desc")
        .orderBy("event_id", "desc")
        .limit(1),
    );
    return row ? loadGovernorTask(db, row.task_id as GovernorTaskId, this.#tasks) : null;
  }

  listEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    if (!loadGovernorTask(db, taskId, this.#tasks)) {
      return [];
    }
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

  listCurrentEffects(taskId: GovernorTaskId): GovernorEffectRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    const task = loadGovernorTask(db, taskId, this.#tasks);
    if (!task) {
      return [];
    }
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseEffectRow);
  }

  loadEffect(taskId: GovernorTaskId, effectId: string): GovernorEffectRecord | null {
    const { db } = openOpenClawStateDatabase(this.#options);
    const task = loadGovernorTask(db, taskId, this.#tasks);
    if (!task) {
      return null;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db)
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("effect_id", "=", effectId),
    );
    if (!row) {
      return null;
    }
    const effect = parseEffectRow(row);
    return effect.objectiveRevision === task.objectiveRevision &&
      effect.planVersion === task.planVersion &&
      effect.executionGeneration === task.executionGeneration
      ? effect
      : null;
  }

  listEvidence(taskId: GovernorTaskId): GovernorEvidenceRecord[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    const task = loadGovernorTask(db, taskId, this.#tasks);
    if (!task) {
      return [];
    }
    return executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .orderBy("created_at", "asc")
        .orderBy("evidence_id", "asc"),
    ).rows.map((row) => parseEvidenceRow(row, this.#verifyEvidence));
  }

  loadEvidence(taskId: GovernorTaskId, evidenceId: string): GovernorEvidenceRecord | null {
    const db = openOpenClawStateDatabase(this.#options).db;
    const task = loadGovernorTask(db, taskId, this.#tasks);
    if (!task) {
      return null;
    }
    const evidence = loadGovernorEvidence(db, taskId, evidenceId, this.#verifyEvidence);
    return evidence &&
      evidence.objectiveRevision === task.objectiveRevision &&
      evidence.planVersion === task.planVersion &&
      evidence.taskVersion <= task.taskVersion
      ? evidence
      : null;
  }

  listUnfinishedFanoutJobIds(task: GovernorTaskProjection): string[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    const current = loadGovernorTask(db, task.taskId, this.#tasks);
    if (!current || !this.#tasks.isCurrent(task)) {
      return [];
    }
    const jobs = executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_fanout_jobs")
        .select(["job_id", "round", "state"])
        .where("task_id", "=", task.taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .orderBy("queue_sequence", "asc")
        .orderBy("job_id", "asc"),
    ).rows;
    const pending = jobs
      .filter((row) => row.state === "queued" || row.state === "running")
      .map((row) => row.job_id);
    for (const round of new Set(
      jobs.filter((row) => row.state === "completed").map((row) => row.round),
    )) {
      const reducer = executeSqliteQueryTakeFirstSync(
        db,
        governorDb(db)
          .selectFrom("governor_fanin_reducers")
          .select("state")
          .where("task_id", "=", task.taskId)
          .where("objective_revision", "=", task.objectiveRevision)
          .where("plan_version", "=", task.planVersion)
          .where("execution_generation", "=", task.executionGeneration)
          .where("round", "=", round),
      );
      if (reducer?.state !== "completed") {
        pending.push(`fanin:${round}`);
      }
    }
    return pending;
  }
}
