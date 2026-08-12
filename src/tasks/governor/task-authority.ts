// Bridges canonical task projections to the private host-owned monotonic task fence.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  isTrustedGovernorTaskAuthority,
  type GovernorTaskFenceBinding,
  type GovernorTrustedTaskAuthority,
} from "../../security/governor-host-readonly.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDb, parseTaskRow } from "./store-codec.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function governorTaskFenceBinding(task: GovernorTaskProjection): GovernorTaskFenceBinding {
  return {
    taskId: task.taskId,
    scopeKey: task.scopeKey,
    state: task.state,
    authenticatedSourceSequence: task.authenticatedSourceSequence,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    leaseEpoch: task.leaseEpoch,
    executionGeneration: task.executionGeneration,
    projection: task as unknown as GovernorJsonValue,
  };
}

export class GovernorTaskAuthorityStore {
  readonly #authority: GovernorTrustedTaskAuthority;

  constructor(authority: GovernorTrustedTaskAuthority) {
    if (!isTrustedGovernorTaskAuthority(authority)) {
      throw new Error("GOVERNOR_TASK_AUTHORITY_REQUIRED");
    }
    this.#authority = authority;
  }

  prepare(task: GovernorTaskProjection): void {
    this.#authority.prepare(governorTaskFenceBinding(task));
  }

  finalize(task: GovernorTaskProjection): void {
    this.#authority.finalize(governorTaskFenceBinding(task));
  }

  reconcile(task: GovernorTaskProjection): boolean {
    return this.#authority.reconcile(governorTaskFenceBinding(task));
  }

  isCurrent(task: GovernorTaskProjection): boolean {
    return this.#authority.matches(governorTaskFenceBinding(task));
  }

  state(taskId: GovernorTaskId) {
    return this.#authority.state(taskId);
  }

  loadCurrent(db: DatabaseSync, taskId: GovernorTaskId): GovernorTaskProjection | null {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      governorDb(db).selectFrom("governor_tasks").selectAll().where("task_id", "=", taskId),
    );
    if (!row) {
      return null;
    }
    const task = parseTaskRow(row);
    return this.isCurrent(task) ? task : null;
  }

  reconcilePrimary(db: DatabaseSync): void {
    const rows = executeSqliteQuerySync(
      db,
      governorDb(db).selectFrom("governor_tasks").selectAll().orderBy("task_id", "asc"),
    ).rows;
    for (const row of rows) {
      this.reconcile(parseTaskRow(row));
    }
  }
}
