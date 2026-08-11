// Atomic authenticated ingress ordering across active and terminal governed tasks.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertValidGovernorContract } from "./contracts.js";
import { createGovernorEventRecord } from "./events.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { bindEvent, bindTask, governorDb, parseTaskRow } from "./store-codec.js";
import { loadGovernorTask } from "./store-queries.js";
import {
  createGovernorTaskProjection,
  opaqueGovernorReference,
  type GovernorEventId,
  type GovernorIdentityContext,
  type GovernorMode,
  type GovernorTaskContract,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

type IngressParams = {
  eventId?: GovernorEventId;
  sourceMessageId: string;
  sourceSequence: number;
  scope: GovernorTaskScope;
  mode: GovernorMode;
  contract: GovernorTaskContract;
  flowId?: string;
  now: number;
};

export type GovernorIngressResult = {
  kind: "created" | "corrected" | "duplicate" | "stale";
  task: GovernorTaskProjection;
};

export function ingestGovernorTask(params: {
  options: OpenClawStateDatabaseOptions;
  identity: GovernorIdentityContext;
  ingress: IngressParams;
}): GovernorIngressResult {
  const input = params.ingress;
  const contract = assertGovernorBoundarySafe(
    "session",
    input.contract as unknown as GovernorJsonValue,
  ) as unknown as GovernorTaskContract;
  assertValidGovernorContract(contract);
  if (!input.sourceMessageId.trim() || !Number.isSafeInteger(input.sourceSequence)) {
    throw new Error("Governor authenticated ingress identity or sequence is invalid");
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const dbx = governorDb(db);
    const incoming = createGovernorTaskProjection({
      scope: input.scope,
      mode: input.mode,
      contract,
      authenticatedSourceSequence: input.sourceSequence,
      flowId: input.flowId,
      now: input.now,
      identity: params.identity,
    });
    const sourceMessageId = opaqueGovernorReference(
      `source-message:${incoming.scopeKey}`,
      input.sourceMessageId,
      params.identity,
    );
    const sourceBindingRef = opaqueGovernorReference(
      `authenticated-source:${incoming.scopeKey}`,
      incoming.scopeKey,
      params.identity,
    );
    const duplicate = executeSqliteQueryTakeFirstSync(
      db,
      dbx
        .selectFrom("governor_events")
        .select(["task_id"])
        .where("scope_key", "=", incoming.scopeKey)
        .where("source_message_id", "=", sourceMessageId),
    );
    if (duplicate) {
      const task = loadGovernorTask(db, duplicate.task_id as GovernorTaskProjection["taskId"]);
      if (!task) {
        throw new Error(`Governor ingress event references missing task ${duplicate.task_id}`);
      }
      return { kind: "duplicate", task };
    }

    const durableHighWater = executeSqliteQueryTakeFirstSync(
      db,
      dbx
        .selectFrom("governor_ingress_source_highwater")
        .selectAll()
        .where("source_binding_ref", "=", sourceBindingRef),
    );
    const legacyTaskRow = durableHighWater
      ? undefined
      : executeSqliteQueryTakeFirstSync(
          db,
          dbx
            .selectFrom("governor_tasks")
            .selectAll()
            .where("scope_key", "=", incoming.scopeKey)
            .orderBy("source_sequence", "desc")
            .orderBy("updated_at", "desc")
            .limit(1),
        );
    const authoritativeSequence = durableHighWater
      ? durableHighWater.source_sequence
      : legacyTaskRow
        ? parseTaskRow(legacyTaskRow).authenticatedSourceSequence
        : -1;
    if (input.sourceSequence <= authoritativeSequence) {
      const taskId = durableHighWater?.task_id ?? legacyTaskRow?.task_id;
      const task = taskId ? loadGovernorTask(db, taskId as GovernorTaskProjection["taskId"]) : null;
      if (!task) {
        throw new Error("Governor authenticated ingress high-water references missing task");
      }
      const event = createGovernorEventRecord({
        task,
        eventId: input.eventId,
        eventType: "stale_ingress_ignored",
        sourceMessageId,
        sourceSequence: input.sourceSequence,
        payload: { authoritativeSequence },
        now: input.now,
      });
      executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
      return { kind: "stale", task };
    }

    const activeRow = executeSqliteQueryTakeFirstSync(
      db,
      dbx
        .selectFrom("governor_tasks")
        .selectAll()
        .where("scope_key", "=", incoming.scopeKey)
        .where("terminal_at", "is", null)
        .orderBy("updated_at", "desc")
        .orderBy("task_id", "asc")
        .limit(1),
    );
    const writeHighWater = (task: GovernorTaskProjection) => {
      executeSqliteQuerySync(
        db,
        dbx
          .insertInto("governor_ingress_source_highwater")
          .values({
            source_binding_ref: sourceBindingRef,
            source_sequence: input.sourceSequence,
            source_message_ref: sourceMessageId,
            task_id: task.taskId,
            updated_at: input.now,
          })
          .onConflict((conflict) =>
            conflict.column("source_binding_ref").doUpdateSet({
              source_sequence: input.sourceSequence,
              source_message_ref: sourceMessageId,
              task_id: task.taskId,
              updated_at: input.now,
            }),
          ),
      );
    };
    if (!activeRow) {
      executeSqliteQuerySync(db, dbx.insertInto("governor_tasks").values(bindTask(incoming)));
      const event = createGovernorEventRecord({
        task: incoming,
        eventId: input.eventId,
        eventType: "task_received",
        sourceMessageId,
        sourceSequence: input.sourceSequence,
        payload: { mode: input.mode },
        now: input.now,
      });
      executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
      writeHighWater(incoming);
      return { kind: "created", task: incoming };
    }

    const current = parseTaskRow(activeRow);
    const corrected: GovernorTaskProjection = {
      ...current,
      mode: input.mode,
      contract,
      plan: undefined,
      conditions: { contradictions: [], pendingUserUpdate: false },
      claims: [],
      state:
        current.state === "RECEIVED" || current.state === "CONTRACTING"
          ? "CONTRACTING"
          : "REPLAN_REQUIRED",
      taskVersion: current.taskVersion + 1,
      objectiveRevision: current.objectiveRevision + 1,
      planVersion: current.planVersion + 1,
      executionGeneration: current.executionGeneration + 1,
      authenticatedSourceSequence: input.sourceSequence,
      updatedAt: input.now,
    };
    const update = executeSqliteQuerySync(
      db,
      dbx
        .updateTable("governor_tasks")
        .set(bindTask(corrected))
        .where("task_id", "=", current.taskId)
        .where("task_version", "=", current.taskVersion)
        .where("lease_epoch", "=", current.leaseEpoch),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error(`Concurrent governor correction for ${current.taskId}`);
    }
    executeSqliteQuerySync(
      db,
      dbx
        .updateTable("governor_action_intents")
        .set({ state: "cancelled", cancelled_at: input.now, updated_at: input.now })
        .where("task_id", "=", current.taskId)
        .where("execution_generation", "!=", corrected.executionGeneration)
        .where("state", "in", ["admitted", "running"]),
    );
    executeSqliteQuerySync(
      db,
      dbx
        .updateTable("governor_fanout_jobs")
        .set({
          state: "cancelled",
          cancelled_at: input.now,
          worker_id: null,
          lease_expires_at: null,
          updated_at: input.now,
        })
        .where("task_id", "=", current.taskId)
        .where("execution_generation", "!=", corrected.executionGeneration)
        .where("state", "in", ["queued", "running"]),
    );
    const event = createGovernorEventRecord({
      task: corrected,
      eventId: input.eventId,
      eventType: "task_corrected",
      sourceMessageId,
      sourceSequence: input.sourceSequence,
      payload: { previousObjectiveRevision: current.objectiveRevision },
      now: input.now,
    });
    executeSqliteQuerySync(db, dbx.insertInto("governor_events").values(bindEvent(event)));
    writeHighWater(corrected);
    return { kind: "corrected", task: corrected };
  }, params.options);
}
