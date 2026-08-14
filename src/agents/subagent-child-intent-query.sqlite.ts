import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable } from "kysely";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type ChildIntentDatabase = Pick<DB, "subagent_child_intents" | "subagent_runs">;
export type ChildIntentRow = Selectable<DB["subagent_child_intents"]>;

export function subagentChildIntentStateFromRecord(
  entry: SubagentRunRecord,
):
  | "reserved"
  | "dispatch_claimed"
  | "gateway_accepted"
  | "registered"
  | "cancelled_requested"
  | "expired" {
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

/** Uses the controller composite identity for bounded authoritative lookup. */
export function findSubagentChildIntentRow(
  database: DatabaseSync,
  db: Kysely<ChildIntentDatabase>,
  controllerSessionKey: string,
  canonicalKey: string,
  operationKey?: string,
): ChildIntentRow | undefined {
  const controller = controllerSessionKey.trim();
  if (!controller) {
    return undefined;
  }
  const canonicalRow = executeSqliteQuerySync(
    database,
    db
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", controller)
      .where("canonical_key", "=", canonicalKey)
      .where("operation_key", "is", null),
  ).rows[0];
  if (!operationKey) {
    return canonicalRow;
  }
  const operationRow = executeSqliteQuerySync(
    database,
    db
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", controller)
      .where("operation_key", "=", operationKey)
      .where("operation_key", "is not", null),
  ).rows[0];
  if (canonicalRow && operationRow && canonicalRow.intent_id !== operationRow.intent_id) {
    throw new Error("child intent canonical and operation identities conflict");
  }
  return operationRow ?? canonicalRow;
}
