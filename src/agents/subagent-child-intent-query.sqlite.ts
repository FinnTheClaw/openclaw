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
  const canonicalRows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("subagent_child_intents")
      .selectAll()
      .where("controller_session_key", "=", controller)
      .where("canonical_key", "=", canonicalKey)
      .orderBy("updated_at", "desc"),
  ).rows;
  const canonicalRow = canonicalRows.find((row) => row.operation_key === null);
  if (!operationKey) {
    if (canonicalRows.length > 1) {
      throw new Error("child intent lookup requires an explicit operation identity");
    }
    // A caller that has only the canonical lookup key may still be recovering
    // a named operation after restart.  Return it only when the composite
    // controller+canonical lookup is unambiguous; never cross controllers.
    return canonicalRows[0];
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
  // An explicit operation key is a caller-owned identity. It must not
  // silently collapse into an older anonymous canonical slot that happens
  // to have the same request shape; distinct named slots are intentional.
  return operationRow;
}
