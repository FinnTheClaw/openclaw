import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { GovernorC02StoreSnapshot } from "../../security/governor-c02-runtime-attestation-model.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { actionIntentDb, parseGovernorActionIntent } from "./action-intent-codec.js";
import { parseGovernorCheckpointRow } from "./checkpoint-store.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import { governorDb, parseEffectRow, parseEventRow, parseEvidenceRow } from "./store-codec.js";
import { loadGovernorTask } from "./store-queries.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import {
  opaqueGovernorReference,
  type GovernorIdentityContext,
  type GovernorTaskId,
} from "./types.js";

type Registration = Readonly<{
  options: OpenClawStateDatabaseOptions;
  tasks: GovernorTaskAuthorityStore;
  identity: GovernorIdentityContext;
  verifyEvidence: (evidence: GovernorEvidenceRecord) => void;
}>;

const REGISTRATIONS = new WeakMap<object, Registration>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/** @internal Registers constructor-owned state; no task-facing store method is added. */
export function registerGovernorC02Store(
  store: GovernorSqliteStore,
  registration: Registration,
): void {
  if (REGISTRATIONS.has(store)) {
    throw new Error("GOVERNOR_C02_STORE_ALREADY_REGISTERED");
  }
  REGISTRATIONS.set(store, registration);
}

/** @internal Runs validation/signing inside one existing-store lock and never returns raw rows. */
export function withGovernorC02AtomicSnapshot<T>(params: {
  store: GovernorSqliteStore;
  taskId: GovernorTaskId;
  consume: (snapshot: GovernorC02StoreSnapshot) => T;
}): T {
  const registration = REGISTRATIONS.get(params.store);
  if (!registration) {
    throw new Error("GOVERNOR_C02_STORE_UNAVAILABLE");
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const task = loadGovernorTask(db, params.taskId, registration.tasks);
    if (!task) {
      throw new Error("GOVERNOR_C02_ATTESTATION_TASK_UNAVAILABLE");
    }
    const dbx = governorDb(db);
    const sourceBindingRef = opaqueGovernorReference(
      `authenticated-source:${task.scopeKey}`,
      task.scopeKey,
      registration.identity,
    );
    const highwater = executeSqliteQueryTakeFirstSync(
      db,
      dbx
        .selectFrom("governor_ingress_source_highwater")
        .selectAll()
        .where("source_binding_ref", "=", sourceBindingRef),
    );
    if (!highwater) {
      throw new Error("GOVERNOR_C02_ATTESTATION_HIGHWATER_UNAVAILABLE");
    }
    const events = executeSqliteQuerySync(
      db,
      dbx
        .selectFrom("governor_events")
        .selectAll()
        .where("task_id", "=", task.taskId)
        .orderBy("created_at", "asc")
        .orderBy("event_id", "asc"),
    ).rows.map(parseEventRow);
    const intents = executeSqliteQuerySync(
      db,
      actionIntentDb(db)
        .selectFrom("governor_action_intents")
        .selectAll()
        .where("task_id", "=", task.taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseGovernorActionIntent);
    const effects = executeSqliteQuerySync(
      db,
      dbx
        .selectFrom("governor_effects")
        .selectAll()
        .where("task_id", "=", task.taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .where("execution_generation", "=", task.executionGeneration)
        .orderBy("created_at", "asc")
        .orderBy("effect_id", "asc"),
    ).rows.map(parseEffectRow);
    const evidence = executeSqliteQuerySync(
      db,
      dbx
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", task.taskId)
        .where("objective_revision", "=", task.objectiveRevision)
        .where("plan_version", "=", task.planVersion)
        .orderBy("created_at", "asc")
        .orderBy("evidence_id", "asc"),
    ).rows.map((row) => parseEvidenceRow(row, registration.verifyEvidence));
    const checkpoints = executeSqliteQuerySync(
      db,
      dbx
        .selectFrom("governor_checkpoints")
        .selectAll()
        .where("task_id", "=", task.taskId)
        .orderBy("created_at", "asc")
        .orderBy("checkpoint_id", "asc"),
    ).rows.map(parseGovernorCheckpointRow);
    return params.consume(
      deepFreeze({
        task,
        highwater: {
          sourceBindingRef,
          sourceSequence: normalizeSqliteNumber(highwater.source_sequence) ?? -1,
          sourceMessageRef: highwater.source_message_ref,
          taskId: highwater.task_id,
          updatedAt: normalizeSqliteNumber(highwater.updated_at) ?? -1,
        },
        events,
        intents,
        effects,
        evidence,
        checkpoints,
      }),
    );
  }, registration.options);
}
