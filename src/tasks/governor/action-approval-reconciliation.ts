// Reconciles host-authoritative approval revocation into durable action state.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  actionIntentDb,
  bindGovernorActionIntent,
  parseGovernorActionIntent,
} from "./action-intent-codec.js";
import type { GovernorActionIntent } from "./action-intent.js";

/**
 * A revoked action that never crossed the effect fence is terminally cancelled.
 * A started action remains physically unresolved and is only cancellation-requested.
 */
export function reconcileRevokedGovernorActionIntent(
  db: DatabaseSync,
  intent: GovernorActionIntent,
  now: number,
): GovernorActionIntent {
  if (intent.state === "completed" || intent.state === "cancelled") {
    return intent;
  }
  const next: GovernorActionIntent =
    intent.effectStartedAt === undefined
      ? {
          ...intent,
          state: "cancelled",
          claimEpoch: intent.claimEpoch + 1,
          cancellationRequestedAt: intent.cancellationRequestedAt ?? now,
          cancelledAt: intent.cancelledAt ?? now,
          updatedAt: now,
        }
      : {
          ...intent,
          cancellationRequestedAt: intent.cancellationRequestedAt ?? now,
          updatedAt: now,
        };
  if (next.state === "cancelled") {
    delete next.leaseExpiresAt;
  }
  const update = executeSqliteQuerySync(
    db,
    actionIntentDb(db)
      .updateTable("governor_action_intents")
      .set(bindGovernorActionIntent(next))
      .where("task_id", "=", intent.taskId)
      .where("effect_id", "=", intent.effectId)
      .where("claim_epoch", "=", intent.claimEpoch)
      .where("updated_at", "=", intent.updatedAt),
  );
  if (update.numAffectedRows === 1n) {
    return next;
  }
  const current = executeSqliteQueryTakeFirstSync(
    db,
    actionIntentDb(db)
      .selectFrom("governor_action_intents")
      .selectAll()
      .where("task_id", "=", intent.taskId)
      .where("effect_id", "=", intent.effectId),
  );
  return current ? parseGovernorActionIntent(current) : intent;
}
