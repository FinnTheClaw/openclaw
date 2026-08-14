import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ChildIntentTable = OpenClawStateKyselyDatabase["subagent_child_intents"];
type ChildIntentRow = Selectable<ChildIntentTable>;
type ChildIntentUpdate = Updateable<ChildIntentTable>;
type ChildIntentDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "subagent_child_intents" | "subagent_runs"
>;

export {
  cancelSubagentChildIntentAtomically,
  expireSubagentReservationsAtomically,
  releaseRegisteredSubagentChildIntent,
  removeSubagentReservationAtomically,
} from "./subagent-child-intent-store-lifecycle.sqlite.js";

export type ChildIntentState =
  | "reserved"
  | "dispatch_claimed"
  | "gateway_accepted"
  | "registered"
  | "cancelled_requested"
  | "expired"
  | "terminal";

const ACTIVE_STATES: readonly ChildIntentState[] = [
  "reserved",
  "dispatch_claimed",
  "gateway_accepted",
  "registered",
];

function parsePayload(raw: string): SubagentRunRecord | undefined {
  try {
    const value = JSON.parse(raw) as SubagentRunRecord;
    return value && typeof value === "object" ? normalizeSubagentRunState(value) : undefined;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: ChildIntentRow): SubagentRunRecord | undefined {
  const payload = parsePayload(row.payload_json);
  if (!payload) {
    return undefined;
  }
  const spawnAdmission =
    row.state === "dispatch_claimed"
      ? "dispatching"
      : row.state === "gateway_accepted"
        ? "unknown"
        : row.state === "registered"
          ? "dispatched"
          : row.state === "cancelled_requested"
            ? "cancelled"
            : row.state === "expired"
              ? "expired"
              : "reserved";
  return normalizeSubagentRunState({
    ...payload,
    runId: row.reservation_run_id,
    childIntentKey: row.canonical_key,
    childIntentLookupKey: row.canonical_key,
    childIntentRequestDigest: row.request_digest,
    childIntentBehaviorDigest: row.resolved_digest,
    childIntentTargetAgentId: row.target_agent_id,
    reservationOwnerToken: row.lease_owner,
    reservationExpiresAt: row.lease_expires_at ?? undefined,
    providerRunId: row.provider_run_id ?? undefined,
    gatewayReceiptId: row.gateway_receipt_id ?? undefined,
    spawnAdmission,
  });
}

function findRow(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  controllerSessionKey: string,
  canonicalKey: string,
  operationKey?: string,
): ChildIntentRow | undefined {
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", controllerSessionKey)
      .where((eb) =>
        eb.or([
          eb("canonical_key", "=", canonicalKey),
          ...(operationKey ? [eb("operation_key", "=", operationKey)] : []),
        ]),
      ),
  ).rows[0];
}

function stateFromRecord(entry: SubagentRunRecord): ChildIntentState {
  switch (entry.spawnAdmission) {
    case "dispatching":
      return "dispatch_claimed";
    case "unknown":
      return "gateway_accepted";
    case "dispatched":
      return "registered";
    case "cancelled":
      return "cancelled_requested";
    case "expired":
      return "expired";
    default:
      return "reserved";
  }
}

function createRow(entry: SubagentRunRecord, now: number): Insertable<ChildIntentTable> {
  const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
  const canonicalKey = (entry.childIntentLookupKey ?? entry.childIntentKey ?? "").trim();
  if (!controller || !canonicalKey || !entry.reservationOwnerToken) {
    throw new Error("child intent admission requires a durable owner binding");
  }
  return {
    intent_id: `${controller}:${canonicalKey}`,
    controller_session_key: controller,
    canonical_key: canonicalKey,
    operation_key: entry.childIntentOperationKey ?? null,
    request_digest: entry.childIntentRequestDigest ?? canonicalKey,
    resolved_digest: entry.childIntentBehaviorDigest ?? canonicalKey,
    target_agent_id: entry.childIntentTargetAgentId ?? "unknown",
    child_session_key: entry.childSessionKey,
    reservation_run_id: entry.runId,
    state: stateFromRecord(entry),
    generation: 0,
    lease_owner: entry.reservationOwnerToken,
    lease_expires_at: entry.reservationExpiresAt ?? null,
    registered_run_id: entry.spawnAdmission === "dispatched" ? (entry.providerRunId ?? null) : null,
    provider_run_id: entry.providerRunId ?? null,
    gateway_receipt_id: null,
    cancel_requested_at: null,
    created_at: entry.createdAt,
    updated_at: now,
    payload_json: JSON.stringify(entry),
  };
}

function setRow(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  intentId: string,
  values: ChildIntentUpdate,
  expected?: {
    generation: number;
    state?: ChildIntentState;
    leaseOwner?: string;
  },
) {
  let query = db
    .updateTable("subagent_child_intents")
    .set(values)
    .where("intent_id", "=", intentId);
  if (expected) {
    query = query.where("generation", "=", expected.generation);
    if (expected.state) {
      query = query.where("state", "=", expected.state);
    }
    if (expected.leaseOwner) {
      query = query.where("lease_owner", "=", expected.leaseOwner);
    }
  }
  return executeSqliteQuerySync(database, query);
}

/** The dedicated row table is the sole linearization point for admission. */
export function reserveSubagentRunAtomically(
  entry: SubagentRunRecord,
  maxActiveChildren?: number,
): SubagentRunRecord | null {
  let winner: SubagentRunRecord | null = null;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
    const canonicalKey = (entry.childIntentLookupKey ?? entry.childIntentKey ?? "").trim();
    const current = findRow(db, stateDb, controller, canonicalKey, entry.childIntentOperationKey);
    if (current) {
      const currentRecord = rowToRecord(current);
      if (!currentRecord) {
        throw new Error("child intent authority row is corrupt");
      }
      if (
        current.request_digest !== (entry.childIntentRequestDigest ?? canonicalKey) ||
        current.resolved_digest !== (entry.childIntentBehaviorDigest ?? canonicalKey)
      ) {
        throw new Error("child intent conflicts with an existing behavior binding");
      }
      if (
        (current.state === "reserved" &&
          current.lease_expires_at !== null &&
          current.lease_expires_at <= Date.now()) ||
        current.state === "expired"
      ) {
        const replacement = createRow(entry, Date.now());
        const changed = setRow(
          db,
          stateDb,
          current.intent_id,
          {
            operation_key: replacement.operation_key,
            request_digest: replacement.request_digest,
            resolved_digest: replacement.resolved_digest,
            target_agent_id: replacement.target_agent_id,
            child_session_key: replacement.child_session_key,
            reservation_run_id: replacement.reservation_run_id,
            state: "reserved",
            generation: current.generation + 1,
            lease_owner: replacement.lease_owner,
            lease_expires_at: replacement.lease_expires_at,
            registered_run_id: null,
            provider_run_id: null,
            gateway_receipt_id: null,
            cancel_requested_at: null,
            updated_at: Date.now(),
            payload_json: replacement.payload_json,
          },
          { generation: current.generation, state: current.state as ChildIntentState },
        );
        if (Number(changed.numAffectedRows ?? 0) !== 1) {
          throw new Error("child intent reservation changed during lease reclaim");
        }
        return;
      }
      winner = currentRecord;
      return;
    }

    if (typeof maxActiveChildren === "number" && Number.isSafeInteger(maxActiveChildren)) {
      const active = executeSqliteQuerySync(
        db,
        stateDb
          .selectFrom("subagent_child_intents")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("controller_session_key", "=", controller)
          .where("state", "in", ACTIVE_STATES),
      ).rows[0]?.count;
      if ((active ?? 0) >= maxActiveChildren) {
        throw new Error(
          `sessions_spawn has reached max active children for this session (${active ?? 0}/${maxActiveChildren})`,
        );
      }
    }

    const row = createRow(entry, Date.now());
    const inserted = executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("subagent_child_intents")
        .values(row)
        .onConflict((conflict) => conflict.doNothing()),
    );
    if (Number(inserted.numAffectedRows ?? 0) === 1) {
      return;
    }
    const committed = findRow(db, stateDb, controller, canonicalKey, entry.childIntentOperationKey);
    if (!committed) {
      throw new Error("child intent reservation did not commit");
    }
    winner = rowToRecord(committed) ?? null;
  });
  return winner;
}

export function findSubagentChildIntent(childIntentKey: string): SubagentRunRecord | undefined {
  let result: SubagentRunRecord | undefined;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", childIntentKey),
    ).rows[0];
    result = row ? rowToRecord(row) : undefined;
  });
  return result;
}

/** Row-CAS transition used for dispatch, acceptance, cancellation, and recovery. */
export function transitionSubagentRunAdmissionAtomically(params: {
  childIntentKey: string;
  reservationOwnerToken: string;
  from: "reserved" | "dispatching" | "unknown";
  to: "dispatching" | "unknown" | "cancelled";
  providerRunId?: string;
  gatewayReceiptId?: string;
}): SubagentRunRecord | null {
  let updated: SubagentRunRecord | null = null;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", params.childIntentKey),
    ).rows[0];
    if (!row || row.lease_owner !== params.reservationOwnerToken) {
      return;
    }
    const expected =
      params.from === "reserved"
        ? "reserved"
        : params.from === "dispatching"
          ? "dispatch_claimed"
          : "gateway_accepted";
    if (
      row.state !== expected ||
      (expected === "reserved" && (row.lease_expires_at ?? 0) <= Date.now())
    ) {
      return;
    }
    const current = rowToRecord(row);
    if (!current) {
      throw new Error("child intent authority row is corrupt");
    }
    const nextState: ChildIntentState =
      params.to === "dispatching"
        ? "dispatch_claimed"
        : params.to === "unknown"
          ? "gateway_accepted"
          : "cancelled_requested";
    const next = normalizeSubagentRunState({
      ...current,
      spawnAdmission: params.to,
      providerRunId: params.providerRunId?.trim() || current.providerRunId,
      ...(params.to !== "dispatching" ? { reservationExpiresAt: undefined } : {}),
    });
    const changed = setRow(
      db,
      stateDb,
      row.intent_id,
      {
        state: nextState,
        generation: row.generation + 1,
        lease_expires_at: next.reservationExpiresAt ?? null,
        provider_run_id: next.providerRunId ?? null,
        gateway_receipt_id: params.gatewayReceiptId ?? row.gateway_receipt_id,
        updated_at: Date.now(),
        payload_json: JSON.stringify(next),
        ...(nextState === "cancelled_requested" ? { cancel_requested_at: Date.now() } : {}),
      },
      {
        generation: row.generation,
        state: row.state as ChildIntentState,
        leaseOwner: params.reservationOwnerToken,
      },
    );
    if (Number(changed.numAffectedRows ?? 0) === 1) {
      updated = next;
    }
  });
  return updated;
}

export function bindSubagentChildIntentResolvedDigestAtomically(params: {
  childIntentKey: string;
  reservationOwnerToken: string;
  resolvedDigest: string;
}): boolean {
  let bound = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", params.childIntentKey),
    ).rows[0];
    if (!row || row.lease_owner !== params.reservationOwnerToken || row.state !== "reserved") {
      return;
    }
    if (row.resolved_digest === params.resolvedDigest) {
      bound = true;
      return;
    }
    const result = setRow(
      db,
      stateDb,
      row.intent_id,
      {
        resolved_digest: params.resolvedDigest,
        generation: row.generation + 1,
        updated_at: Date.now(),
      },
      { generation: row.generation, state: "reserved", leaseOwner: params.reservationOwnerToken },
    );
    bound = Number(result.numAffectedRows ?? 0) === 1;
  });
  return bound;
}

export function claimSubagentChildIntentAtomically(params: {
  childIntentKey: string;
  reservationOwnerToken: string;
}): string | false {
  let token: string | false = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_child_intents")
        .selectAll()
        .where("canonical_key", "=", params.childIntentKey),
    ).rows[0];
    if (
      !row ||
      !["dispatch_claimed", "gateway_accepted"].includes(row.state) ||
      row.lease_owner !== params.reservationOwnerToken
    ) {
      return;
    }
    const nextToken = crypto.randomUUID();
    const changed = setRow(
      db,
      stateDb,
      row.intent_id,
      {
        lease_owner: nextToken,
        generation: row.generation + 1,
        updated_at: Date.now(),
      },
      { generation: row.generation, leaseOwner: params.reservationOwnerToken },
    );
    if (Number(changed.numAffectedRows ?? 0) === 1) {
      token = nextToken;
    }
  });
  return token;
}

export function commitSubagentRunRegistrationInTransaction(
  db: DatabaseSync,
  entry: SubagentRunRecord,
): boolean {
  if (!entry.childIntentKey || !entry.reservationOwnerToken) {
    return true;
  }
  const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("canonical_key", "=", entry.childIntentKey!),
  ).rows[0];
  if (!row || row.lease_owner !== entry.reservationOwnerToken) {
    return false;
  }
  if (row.state === "registered" && row.registered_run_id === entry.runId) {
    return true;
  }
  if (!["dispatch_claimed", "gateway_accepted"].includes(row.state)) {
    return false;
  }
  const result = setRow(
    db,
    stateDb,
    row.intent_id,
    {
      state: "registered",
      generation: row.generation + 1,
      registered_run_id: entry.runId,
      provider_run_id: entry.providerRunId ?? entry.runId,
      updated_at: Date.now(),
      payload_json: JSON.stringify(entry),
    },
    {
      generation: row.generation,
      state: row.state as ChildIntentState,
      leaseOwner: entry.reservationOwnerToken,
    },
  );
  return Number(result.numAffectedRows ?? 0) === 1;
}

export function commitSubagentRunRegistrationAtomically(entry: SubagentRunRecord): boolean {
  let committed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    committed = commitSubagentRunRegistrationInTransaction(db, entry);
  });
  return committed;
}
