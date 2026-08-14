import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { countActiveRunsForSessionFromRuns } from "./subagent-registry-queries.js";
import {
  rowToSubagentRunRecord,
  subagentRunRecordToSqliteInsert,
  subagentRunRecordToSqliteUpdate,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

/** Atomically admits one logical child and enforces the controller capacity. */
export function reserveSubagentRunAtomically(
  entry: SubagentRunRecord,
  maxActiveChildren?: number,
): SubagentRunRecord | null {
  let existing: SubagentRunRecord | null = null;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const rows = executeSqliteQuerySync(db, stateDb.selectFrom("subagent_runs").selectAll()).rows;
    let candidates = rows
      .map((row) => rowToSubagentRunRecord(row))
      .filter((candidate): candidate is SubagentRunRecord => candidate !== null);
    for (const candidate of candidates) {
      if (
        candidate.childIntentKey === entry.childIntentKey &&
        (candidate.controllerSessionKey ?? candidate.requesterSessionKey) ===
          (entry.controllerSessionKey ?? entry.requesterSessionKey)
      ) {
        if (
          candidate.spawnAdmission === "reserved" &&
          typeof candidate.reservationExpiresAt === "number" &&
          candidate.reservationExpiresAt <= Date.now()
        ) {
          executeSqliteQuerySync(
            db,
            stateDb.deleteFrom("subagent_runs").where("run_id", "=", candidate.runId),
          );
          candidates = candidates.filter((item) => item.runId !== candidate.runId);
          continue;
        }
        existing = candidate;
        return;
      }
    }
    if (
      typeof maxActiveChildren === "number" &&
      Number.isSafeInteger(maxActiveChildren) &&
      countActiveRunsForSessionFromRuns(
        new Map(candidates.map((candidate) => [candidate.runId, candidate])),
        entry.controllerSessionKey ?? entry.requesterSessionKey,
      ) >= maxActiveChildren
    ) {
      throw new Error(
        `sessions_spawn has reached max active children for this session (limit=${maxActiveChildren})`,
      );
    }
    const values = subagentRunRecordToSqliteInsert(entry);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("subagent_runs")
        .values(values)
        .onConflict((conflict) => conflict.column("run_id").doNothing()),
    );
  });
  return existing;
}

/** CASes a reservation state under SQLite's write lock before any RPC. */
export function transitionSubagentRunAdmissionAtomically(params: {
  runId: string;
  childIntentKey: string;
  reservationOwnerToken: string;
  from: "reserved" | "dispatching" | "unknown";
  to: "dispatching" | "unknown" | "cancelled";
  providerRunId?: string;
}): SubagentRunRecord | null {
  let updated: SubagentRunRecord | null = null;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb.selectFrom("subagent_runs").selectAll().where("run_id", "=", params.runId),
    ).rows[0];
    const entry = row ? rowToSubagentRunRecord(row) : null;
    if (
      !entry ||
      entry.childIntentKey !== params.childIntentKey ||
      entry.reservationOwnerToken !== params.reservationOwnerToken ||
      entry.spawnAdmission !== params.from ||
      (params.from === "reserved" &&
        typeof entry.reservationExpiresAt === "number" &&
        entry.reservationExpiresAt <= Date.now())
    ) {
      return;
    }
    const next = normalizeSubagentRunState({
      ...entry,
      spawnAdmission: params.to,
      providerRunId: params.providerRunId?.trim() || entry.providerRunId,
      ...(params.to === "unknown" || params.to === "cancelled"
        ? { reservationExpiresAt: undefined }
        : {}),
    });
    const values = subagentRunRecordToSqliteInsert(next);
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("subagent_runs")
        .set(subagentRunRecordToSqliteUpdate(values))
        .where("run_id", "=", params.runId)
        .where("payload_json", "=", row.payload_json),
    );
    updated = next;
  });
  return updated;
}

/** Removes only an owner-held reservation or an unsubmitted expired lease. */
export function removeSubagentReservationAtomically(params: {
  runId: string;
  childIntentKey: string;
  reservationOwnerToken?: string;
  onlyExpired?: boolean;
  allowUnknown?: boolean;
}): boolean {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb.selectFrom("subagent_runs").selectAll().where("run_id", "=", params.runId),
    ).rows[0];
    const entry = row ? rowToSubagentRunRecord(row) : null;
    if (
      !entry ||
      entry.childIntentKey !== params.childIntentKey ||
      (entry.spawnAdmission !== "reserved" &&
        entry.spawnAdmission !== "dispatching" &&
        !(params.allowUnknown === true && entry.spawnAdmission === "unknown")) ||
      (params.reservationOwnerToken !== undefined &&
        entry.reservationOwnerToken !== params.reservationOwnerToken) ||
      (params.onlyExpired !== true && params.reservationOwnerToken === undefined) ||
      (params.onlyExpired === true && entry.spawnAdmission !== "reserved") ||
      (params.onlyExpired === true &&
        (typeof entry.reservationExpiresAt !== "number" || entry.reservationExpiresAt > Date.now()))
    ) {
      return;
    }
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "=", params.runId),
    );
    removed = true;
  });
  return removed;
}

/** Removes only expired pre-dispatch reservations; dispatching rows remain fenced. */
export function expireSubagentReservationsAtomically(now = Date.now()): string[] {
  const expired: string[] = [];
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const rows = executeSqliteQuerySync(db, stateDb.selectFrom("subagent_runs").selectAll()).rows;
    for (const row of rows) {
      const entry = rowToSubagentRunRecord(row);
      if (
        entry?.spawnAdmission === "reserved" &&
        typeof entry.reservationExpiresAt === "number" &&
        entry.reservationExpiresAt <= now
      ) {
        executeSqliteQuerySync(
          db,
          stateDb.deleteFrom("subagent_runs").where("run_id", "=", entry.runId),
        );
        expired.push(entry.runId);
      }
    }
  });
  return expired;
}
