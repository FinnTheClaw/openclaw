import crypto from "node:crypto";
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ChildIntentTable = DB["subagent_child_intents"];
type ChildIntentDb = Pick<DB, "subagent_child_intents">;

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function legacyRow(entry: SubagentRunRecord, now: number): Insertable<ChildIntentTable> {
  const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
  const canonical = entry.childIntentKey?.trim() || `legacy:${entry.runId}`;
  const state =
    entry.spawnAdmission === "dispatched"
      ? "registered"
      : entry.spawnAdmission === "reserved" &&
          (entry.reservationExpiresAt ?? 0) > now &&
          typeof entry.reservationOwnerToken === "string"
        ? "reserved"
        : entry.endedAt !== undefined
          ? "terminal"
          : "legacy_ambiguous";
  const requestDigest = entry.childIntentRequestDigest ?? canonical;
  return {
    intent_id: `${controller}:${canonical}`,
    controller_session_key: controller,
    canonical_key: canonical,
    operation_key: entry.childIntentOperationKey ?? null,
    request_digest: requestDigest,
    preparation_digest:
      entry.childIntentPreparationDigest ?? entry.childIntentBehaviorDigest ?? canonical,
    resolved_digest: entry.childIntentBehaviorDigest ?? "",
    target_agent_id: entry.childIntentTargetAgentId ?? "unknown",
    child_session_key: entry.childSessionKey,
    reservation_run_id: entry.runId,
    state,
    generation: entry.generation ?? 1,
    lease_owner: entry.reservationOwnerToken ?? `legacy:${digest(entry.runId).slice(0, 24)}`,
    lease_expires_at: entry.reservationExpiresAt ?? null,
    registered_run_id: state === "registered" ? entry.runId : null,
    provider_run_id: entry.providerRunId ?? null,
    gateway_receipt_id: entry.gatewayReceiptId ?? null,
    cancel_requested_at: null,
    created_at: entry.createdAt,
    updated_at: now,
    payload_json: JSON.stringify(entry),
  };
}

/** One-time, idempotent import of legacy registry rows into child-intent authority. */
export function backfillLegacyChildIntents(entries: Iterable<SubagentRunRecord>): void {
  const rows = [...entries]
    .filter((entry) => entry.childIntentKey || entry.spawnAdmission)
    .map((entry) => legacyRow(entry, Date.now()));
  if (rows.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ChildIntentDb>(db);
    for (const row of rows) {
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("subagent_child_intents")
          .values(row)
          .onConflict((conflict) => conflict.doNothing()),
      );
    }
  });
}
