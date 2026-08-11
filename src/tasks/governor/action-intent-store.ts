// Persists and lease-claims pre-execution action intents independently of task projection code.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GovernorActionIntent } from "./action-intent.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorTaskId } from "./types.js";

type ActionIntentDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_tasks" | "governor_action_intents"
>;
type GovernorActionIntentRow = Selectable<OpenClawStateKyselyDatabase["governor_action_intents"]>;

export type GovernorActionIntentUpdate = {
  current: GovernorActionIntent;
  next: GovernorActionIntent;
};

export type GovernorActionIntentClaimResult =
  | { kind: "claimed"; intent: GovernorActionIntent }
  | { kind: "busy" | "stale_worker" | "not_found" | "completed" };

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<ActionIntentDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid persisted governor ${label}`, { cause: error });
  }
}

export function bindGovernorActionIntent(
  intent: GovernorActionIntent,
): Insertable<GovernorActionIntentRow> {
  return {
    task_id: intent.taskId,
    effect_id: intent.effectId,
    idempotency_key: intent.idempotencyKey,
    task_version: intent.taskVersion,
    objective_revision: intent.objectiveRevision,
    plan_version: intent.planVersion,
    lease_epoch: intent.leaseEpoch,
    execution_generation: intent.executionGeneration,
    state: intent.state,
    claim_epoch: intent.claimEpoch,
    claimed_by: intent.claimedBy ?? null,
    lease_expires_at: intent.leaseExpiresAt ?? null,
    proposal_json: JSON.stringify(intent.proposal),
    proposal_digest: intent.proposalDigest,
    action_fingerprint: intent.actionFingerprint,
    progress_vector_hash: intent.progressVectorHash,
    force_replan_after_outcome: intent.forceReplanAfterOutcome ? 1 : 0,
    created_at: intent.createdAt,
    completed_at: intent.completedAt ?? null,
    cancelled_at: intent.cancelledAt ?? null,
    updated_at: intent.updatedAt,
  };
}

function parseActionIntent(row: GovernorActionIntentRow): GovernorActionIntent {
  const proposal = parseJson(
    row.proposal_json,
    "action intent",
  ) as GovernorActionIntent["proposal"];
  const intent: GovernorActionIntent = {
    taskId: row.task_id as GovernorTaskId,
    effectId: row.effect_id,
    idempotencyKey: row.idempotency_key,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    executionGeneration: normalizeSqliteNumber(row.execution_generation) ?? 0,
    state: row.state as GovernorActionIntent["state"],
    claimEpoch: normalizeSqliteNumber(row.claim_epoch) ?? 0,
    ...(row.claimed_by == null ? {} : { claimedBy: row.claimed_by }),
    ...(row.lease_expires_at == null
      ? {}
      : { leaseExpiresAt: normalizeSqliteNumber(row.lease_expires_at) ?? 0 }),
    proposal,
    proposalDigest: row.proposal_digest,
    actionFingerprint: row.action_fingerprint,
    progressVectorHash: row.progress_vector_hash,
    forceReplanAfterOutcome: row.force_replan_after_outcome === 1,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(row.completed_at == null
      ? {}
      : { completedAt: normalizeSqliteNumber(row.completed_at) ?? 0 }),
    ...(row.cancelled_at == null
      ? {}
      : { cancelledAt: normalizeSqliteNumber(row.cancelled_at) ?? 0 }),
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
  if (
    governorDigest(proposal as unknown as GovernorJsonValue) !== intent.proposalDigest ||
    proposal.taskId !== intent.taskId ||
    proposal.effectId !== intent.effectId
  ) {
    throw new Error(`Persisted governor action intent mismatch for ${row.effect_id}`);
  }
  return intent;
}

export class GovernorActionIntentStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
  }

  load(taskId: GovernorTaskId, effectId: string): GovernorActionIntent | null {
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_action_intents")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("effect_id", "=", effectId),
    );
    return row ? parseActionIntent(row) : null;
  }

  listPendingIds(taskId: GovernorTaskId, objectiveRevision: number): string[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_action_intents")
        .select(["effect_id"])
        .where("task_id", "=", taskId)
        .where("objective_revision", "=", objectiveRevision)
        .where("state", "in", ["admitted", "running"])
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map((row) => row.effect_id);
  }

  claim(params: {
    taskId: GovernorTaskId;
    effectId: string;
    objectiveRevision: number;
    planVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    workerId: string;
    leaseDurationMs?: number;
    now: number;
  }): GovernorActionIntentClaimResult {
    const workerId = params.workerId.trim();
    if (!workerId) {
      throw new Error("Governor action workerId must not be empty");
    }
    const leaseDurationMs = params.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Governor action leaseDurationMs must be a positive safe integer");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const task = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_tasks")
          .select([
            "state",
            "objective_revision",
            "plan_version",
            "lease_epoch",
            "execution_generation",
          ])
          .where("task_id", "=", params.taskId),
      );
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_action_intents")
          .selectAll()
          .where("task_id", "=", params.taskId)
          .where("effect_id", "=", params.effectId),
      );
      if (!task || !row) {
        return { kind: "not_found" };
      }
      const intent = parseActionIntent(row);
      if (intent.state === "completed") {
        return { kind: "completed" };
      }
      if (
        task.state !== "EXECUTING" ||
        normalizeSqliteNumber(task.objective_revision) !== params.objectiveRevision ||
        normalizeSqliteNumber(task.plan_version) !== params.planVersion ||
        normalizeSqliteNumber(task.lease_epoch) !== params.leaseEpoch ||
        normalizeSqliteNumber(task.execution_generation) !== params.executionGeneration ||
        intent.objectiveRevision !== params.objectiveRevision ||
        intent.planVersion !== params.planVersion ||
        intent.leaseEpoch !== params.leaseEpoch ||
        intent.executionGeneration !== params.executionGeneration ||
        intent.state === "cancelled"
      ) {
        return { kind: "stale_worker" };
      }
      if (
        intent.state === "running" &&
        intent.leaseExpiresAt !== undefined &&
        intent.leaseExpiresAt > params.now
      ) {
        return intent.claimedBy === workerId ? { kind: "claimed", intent } : { kind: "busy" };
      }
      const claimed: GovernorActionIntent = {
        ...intent,
        state: "running",
        claimEpoch: intent.claimEpoch + 1,
        claimedBy: workerId,
        leaseExpiresAt: params.now + leaseDurationMs,
        updatedAt: params.now,
      };
      const update = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_action_intents")
          .set(bindGovernorActionIntent(claimed))
          .where("task_id", "=", intent.taskId)
          .where("effect_id", "=", intent.effectId)
          .where("claim_epoch", "=", intent.claimEpoch)
          .where("updated_at", "=", intent.updatedAt),
      );
      return update.numAffectedRows === 1n
        ? { kind: "claimed", intent: claimed }
        : { kind: "busy" };
    }, this.#options);
  }
}
