// Applies current-fence, compare-and-swap transitions to durable memory repair state.
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
import {
  bindGovernorMemoryRemediation,
  parseGovernorMemoryRemediation,
  type GovernorMemoryRemediation,
} from "./memory-remediation.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorTaskId, GovernorTaskProjection } from "./types.js";

type RepairDatabase = Pick<OpenClawStateKyselyDatabase, "governor_memory_remediations">;

export type GovernorMemoryRepairFence = Readonly<{
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
}>;

export type GovernorMemoryRepairMutationGuard = Readonly<{
  taskId: GovernorTaskId;
  executionFence: GovernorMemoryRepairFence;
  expectedStatus: GovernorMemoryRemediation["status"];
  expectedUpdatedAt: number;
}>;

export function assertGovernorMemoryTaskExecutionFenceCurrent(params: {
  db: DatabaseSync;
  taskId: GovernorTaskId;
  executionFence: GovernorMemoryRepairFence;
  tasks: GovernorTaskAuthorityStore;
}): GovernorTaskProjection {
  const task = params.tasks.loadCurrent(params.db, params.taskId);
  const fence = params.executionFence;
  if (
    !task ||
    fence.taskVersion !== task.taskVersion ||
    task.objectiveRevision !== fence.objectiveRevision ||
    task.planVersion !== fence.planVersion ||
    task.executionGeneration !== fence.executionGeneration
  ) {
    throw new Error("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
  }
  return task;
}

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<RepairDatabase>(db);
}

function loadRepair(db: DatabaseSync, fingerprint: string): GovernorMemoryRemediation | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_memory_remediations")
      .selectAll()
      .where("contradiction_fingerprint", "=", fingerprint),
  );
  return row ? parseGovernorMemoryRemediation(row) : null;
}

export function assertGovernorMemoryRepairMutationCurrent(params: {
  db: DatabaseSync;
  current: GovernorMemoryRemediation;
  guard: GovernorMemoryRepairMutationGuard;
  tasks: GovernorTaskAuthorityStore;
}): void {
  const task = assertGovernorMemoryTaskExecutionFenceCurrent({
    db: params.db,
    taskId: params.guard.taskId,
    executionFence: params.guard.executionFence,
    tasks: params.tasks,
  });
  if (params.current.taskId !== task.taskId) {
    throw new Error("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
  }
}

function assertExpectedRepair(
  current: GovernorMemoryRemediation,
  guard: GovernorMemoryRepairMutationGuard,
): void {
  if (current.status !== guard.expectedStatus || current.updatedAt !== guard.expectedUpdatedAt) {
    throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
  }
}

export function updateGovernorMemoryRepairState(params: {
  options: OpenClawStateDatabaseOptions;
  tasks: GovernorTaskAuthorityStore;
  fingerprint: string;
  status: "repairing" | "blocked";
  blockedReason?: string;
  now: number;
  guard: GovernorMemoryRepairMutationGuard;
}): GovernorMemoryRemediation | null {
  assertGovernorPersistedJson("log", {
    fingerprint: params.fingerprint,
    status: params.status,
    blockedReason: params.blockedReason ?? null,
    now: params.now,
    guard: params.guard,
  });
  return runOpenClawStateWriteTransaction(({ db }) => {
    const current = loadRepair(db, params.fingerprint);
    if (!current || current.status === "verified") {
      return current;
    }
    assertGovernorMemoryRepairMutationCurrent({
      db,
      current,
      guard: params.guard,
      tasks: params.tasks,
    });
    const blockedReason =
      params.status === "blocked" ? params.blockedReason?.trim() || "repair_failed" : undefined;
    if (current.status === params.status && current.blockedReason === blockedReason) {
      return current;
    }
    assertExpectedRepair(current, params.guard);
    const next: GovernorMemoryRemediation = {
      ...current,
      status: params.status,
      ...(params.status === "blocked" ? { blockedReason } : { blockedReason: undefined }),
      updatedAt: params.now,
    };
    const update = executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_memory_remediations")
        .set(bindGovernorMemoryRemediation(next))
        .where("contradiction_fingerprint", "=", params.fingerprint)
        .where("task_id", "=", params.guard.taskId)
        .where("status", "=", params.guard.expectedStatus)
        .where("updated_at", "=", params.guard.expectedUpdatedAt),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
    }
    return next;
  }, params.options);
}

export function requeueGovernorMemoryRepair(params: {
  options: OpenClawStateDatabaseOptions;
  tasks: GovernorTaskAuthorityStore;
  fingerprint: string;
  now: number;
  guard: GovernorMemoryRepairMutationGuard;
}): GovernorMemoryRemediation | null {
  assertGovernorPersistedJson("log", {
    fingerprint: params.fingerprint,
    now: params.now,
    guard: params.guard,
  });
  return runOpenClawStateWriteTransaction(({ db }) => {
    const current = loadRepair(db, params.fingerprint);
    if (!current) {
      return current;
    }
    assertGovernorMemoryRepairMutationCurrent({
      db,
      current,
      guard: params.guard,
      tasks: params.tasks,
    });
    if (current.status === "queued") {
      return current;
    }
    assertExpectedRepair(current, params.guard);
    if (current.status !== "blocked") {
      throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
    }
    const next: GovernorMemoryRemediation = {
      ...current,
      status: "queued",
      blockedReason: undefined,
      updatedAt: params.now,
    };
    const update = executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_memory_remediations")
        .set(bindGovernorMemoryRemediation(next))
        .where("contradiction_fingerprint", "=", params.fingerprint)
        .where("task_id", "=", params.guard.taskId)
        .where("status", "=", params.guard.expectedStatus)
        .where("updated_at", "=", params.guard.expectedUpdatedAt),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
    }
    return next;
  }, params.options);
}
