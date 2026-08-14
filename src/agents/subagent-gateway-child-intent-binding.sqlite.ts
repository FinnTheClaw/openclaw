import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable } from "kysely";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { GatewayAcceptanceReceiptEnvelope } from "./subagent-gateway-acceptance-receipt-auth.js";

type ChildIntentRow = Selectable<DB["subagent_child_intents"]>;
type ReceiptDb = Pick<DB, "subagent_child_intents" | "subagent_gateway_acceptance_receipts">;

export function findReceiptBoundChildIntent(
  database: DatabaseSync,
  stateDb: Kysely<ReceiptDb>,
  params: {
    controllerSessionKey: string;
    acceptanceKey: string;
    envelope: GatewayAcceptanceReceiptEnvelope;
  },
): { row?: ChildIntentRow; ambiguous: boolean } {
  let query = stateDb
    .selectFrom("subagent_child_intents")
    .selectAll()
    .where("controller_session_key", "=", params.controllerSessionKey);
  if (params.envelope.childIntentCanonicalKey) {
    query = query
      .where("canonical_key", "=", params.envelope.childIntentCanonicalKey)
      .$if(params.envelope.childIntentOperationKey !== undefined, (current) =>
        current.where("operation_key", "=", params.envelope.childIntentOperationKey!),
      )
      .$if(params.envelope.childIntentOperationKey === undefined, (current) =>
        current.where("operation_key", "is", null),
      );
  } else {
    query = query.where("gateway_receipt_id", "=", params.acceptanceKey);
  }
  const rows = executeSqliteQuerySync(database, query).rows;
  return {
    ...(rows.length === 1 ? { row: rows[0] } : {}),
    ambiguous: rows.length > 1,
  };
}

export function bindReceiptToChildIntentInTransaction(
  database: DatabaseSync,
  stateDb: Kysely<ReceiptDb>,
  params: {
    controllerSessionKey: string;
    acceptanceKey: string;
    envelope: GatewayAcceptanceReceiptEnvelope;
  },
): boolean {
  if (!params.envelope.childIntentCanonicalKey) {
    return true;
  }
  const match = findReceiptBoundChildIntent(database, stateDb, params);
  const row = match.row;
  if (
    match.ambiguous ||
    !row ||
    !["reserved", "dispatch_claimed", "gateway_accepted", "registered"].includes(row.state)
  ) {
    return false;
  }
  if (row.gateway_receipt_id === params.acceptanceKey) {
    return true;
  }
  if (row.gateway_receipt_id !== null) {
    return false;
  }
  const updated = executeSqliteQuerySync(
    database,
    stateDb
      .updateTable("subagent_child_intents")
      .set({ gateway_receipt_id: params.acceptanceKey, updated_at: Date.now() })
      .where("intent_id", "=", row.intent_id)
      .where("generation", "=", row.generation)
      .where("gateway_receipt_id", "is", null),
  );
  return Number(updated.numAffectedRows ?? 0) === 1;
}
