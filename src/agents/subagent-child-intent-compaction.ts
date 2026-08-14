import type { Selectable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";

type ChildIntentRow = Selectable<DB["subagent_child_intents"]>;

/** Keep terminal replay proof without retaining the original task payload. */
export function compactSubagentChildIntentPayload(row: ChildIntentRow): string {
  return JSON.stringify({
    schema: "openclaw.child-intent.terminal.v1",
    intentId: row.intent_id,
    controllerSessionKey: row.controller_session_key,
    canonicalKey: row.canonical_key,
    operationKey: row.operation_key,
    requestDigest: row.request_digest,
    preparationDigest: row.preparation_digest,
    resolvedDigest: row.resolved_digest,
    targetAgentId: row.target_agent_id,
    childSessionKey: row.child_session_key,
    reservationRunId: row.reservation_run_id,
    registeredRunId: row.registered_run_id,
    providerRunId: row.provider_run_id,
    gatewayReceiptId: row.gateway_receipt_id,
    generation: row.generation,
  });
}
