import type { DatabaseSync } from "node:sqlite";
import { expireSubagentChildIntentAfterFailedBeforeStartInDatabase } from "./subagent-child-intent-failed-before-start.sqlite.js";

/** Couples receipt failure proof to retirement of the matching child row. */
export function settleGatewayAcceptanceFailedBeforeStartInDatabase(params: {
  database: DatabaseSync;
  acceptanceKey: string;
  gatewayRunId: string;
  controllerSessionKey: string;
  intentId: string;
  transition: () => boolean;
}): boolean {
  const changed = params.transition();
  if (!changed) {
    return false;
  }
  const childRetirement = expireSubagentChildIntentAfterFailedBeforeStartInDatabase(
    params.database,
    {
      controllerSessionKey: params.controllerSessionKey,
      childIntentKey: params.intentId,
      gatewayRunId: params.gatewayRunId,
      receiptKey: params.acceptanceKey,
    },
  );
  if (childRetirement.matched && !childRetirement.changed) {
    throw new Error("child intent failed-before-start retirement lost its CAS race");
  }
  return true;
}
