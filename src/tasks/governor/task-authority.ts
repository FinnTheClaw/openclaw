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
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { governorDb, parseTaskRow } from "./store-codec.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

export function governorTaskFenceBinding(task: GovernorTaskProjection): GovernorTaskFenceBinding {
  const {
    createdAt: _createdAt,
    terminalAt: _terminalAt,
    updatedAt: _updatedAt,
    ...operation
  } = task;
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
    operationDigest: governorDigest(operation as unknown as GovernorJsonValue),
    projection: task as unknown as GovernorJsonValue,
  };
}

export class GovernorTaskAuthorityStore {
  readonly #authority: GovernorTrustedTaskAuthority;
  readonly #validate: (task: GovernorTaskProjection) => void;

  constructor(
    authority: GovernorTrustedTaskAuthority,
    validate: (task: GovernorTaskProjection) => void = () => undefined,
  ) {
    if (!isTrustedGovernorTaskAuthority(authority)) {
      throw new Error("GOVERNOR_TASK_AUTHORITY_REQUIRED");
    }
    this.#authority = authority;
    this.#validate = validate;
  }

  prepare(task: GovernorTaskProjection): void {
    this.#authority.prepare(governorTaskFenceBinding(task));
  }

  finalize(task: GovernorTaskProjection): void {
    this.#authority.finalize(governorTaskFenceBinding(task));
  }

  reconcile(
    task: GovernorTaskProjection,
    strategy: "target-only" | "target-or-prior" = "target-only",
  ): boolean {
    return this.#authority.reconcile(governorTaskFenceBinding(task), strategy);
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
    this.#validate(task);
    if (this.isCurrent(task)) {
      return task;
    }
    return this.reconcile(task) ? task : null;
  }

  reconcilePrimary(db: DatabaseSync): void {
    const rows = executeSqliteQuerySync(
      db,
      governorDb(db).selectFrom("governor_tasks").selectAll().orderBy("task_id", "asc"),
    ).rows;
    for (const row of rows) {
      const task = parseTaskRow(row);
      this.#validate(task);
      this.reconcile(task, "target-or-prior");
    }
  }
}
