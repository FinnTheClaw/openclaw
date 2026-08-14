import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { compactSubagentChildIntentPayload } from "./subagent-child-intent-compaction.js";
import type { ChildIntentDatabase } from "./subagent-child-intent-query.sqlite.js";

/**
 * Retires a child row only when an authenticated Gateway receipt proves that
 * the attempt reached no physical provider/process handoff. This is kept in
 * its own leaf so receipt settlement and ordinary child admission do not grow
 * each other's authority modules.
 */
export function expireSubagentChildIntentAfterFailedBeforeStartInDatabase(
  database: DatabaseSync,
  params: {
    controllerSessionKey: string;
    childIntentKey: string;
    gatewayRunId: string;
    receiptKey: string;
  },
): { matched: boolean; changed: boolean } {
  const stateDb = getNodeSqliteKysely<ChildIntentDatabase>(database);
  const row = executeSqliteQuerySync(
    database,
    stateDb
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", params.controllerSessionKey)
      .where((eb) =>
        eb.or([
          eb("canonical_key", "=", params.childIntentKey),
          eb("canonical_key", "=", params.receiptKey),
          eb("intent_id", "=", params.childIntentKey),
          eb("gateway_receipt_id", "=", params.receiptKey),
        ]),
      ),
  ).rows[0];
  if (!row) {
    return { matched: false, changed: false };
  }
  if (
    !["dispatch_claimed", "gateway_accepted", "registered"].includes(row.state) ||
    (row.provider_run_id !== null && row.provider_run_id !== params.gatewayRunId)
  ) {
    return { matched: true, changed: false };
  }
  const nextGeneration = row.generation + 1;
  const update = executeSqliteQuerySync(
    database,
    stateDb
      .updateTable("subagent_child_intents")
      .set({
        state: "expired",
        generation: nextGeneration,
        lease_expires_at: null,
        registered_run_id: null,
        provider_run_id: null,
        cancel_requested_at: null,
        updated_at: Date.now(),
        payload_json: compactSubagentChildIntentPayload({
          ...row,
          generation: nextGeneration,
          state: "expired",
        }),
      })
      .where("intent_id", "=", row.intent_id)
      .where("generation", "=", row.generation)
      .where("state", "=", row.state),
  );
  return { matched: true, changed: Number(update.numAffectedRows ?? 0) === 1 };
}
