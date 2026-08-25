import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as StateDb } from "../state/openclaw-state-db.generated.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";

type ApprovalDb = Pick<
  StateDb,
  "governor_action_intents" | "governor_approval_epochs" | "governor_approval_grants"
>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<ApprovalDb>(db);

export const approvalScopeKey = (scopeKey: string) => governorDigest({ kind: "scope", scopeKey });

export const approvalGrantKey = (scopeKey: string, grantId: string) =>
  governorDigest({ kind: "grant", scopeKey, grantId });

export function primaryApprovalEpoch(db: DatabaseSync, scopeKey: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_approval_epochs")
      .select("epoch")
      .where("scope_key", "=", scopeKey),
  );
  return normalizeSqliteNumber(row?.epoch ?? null) ?? 0;
}

export function writeApprovalEpoch(
  db: DatabaseSync,
  scopeKey: string,
  epoch: number,
  observedAt: number,
): void {
  executeSqliteQuerySync(
    db,
    dbx(db)
      .insertInto("governor_approval_epochs")
      .values({ scope_key: scopeKey, epoch, updated_at: observedAt })
      .onConflict((conflict) =>
        conflict.column("scope_key").doUpdateSet({ epoch, updated_at: observedAt }),
      ),
  );
}

export function requestStartedApprovalCancellation(
  db: DatabaseSync,
  grantId: string,
  now: number,
): boolean {
  const rows = executeSqliteQuerySync(
    db,
    dbx(db)
      .selectFrom("governor_action_intents")
      .selectAll()
      .where("state", "=", "running")
      .where("effect_started_at", "is not", null),
  );
  let found = false;
  for (const row of rows.rows) {
    try {
      const proposal = JSON.parse(row.proposal_json) as unknown;
      if (typeof proposal !== "object" || proposal === null) {
        return true;
      }
      if (!("approvalGrantId" in proposal)) {
        if (normalizeSqliteNumber(row.approval_required) === 1) {
          return true;
        }
        continue;
      }
      if (proposal.approvalGrantId !== grantId) {
        continue;
      }
      found = true;
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_action_intents")
          .set({ cancellation_requested_at: row.cancellation_requested_at ?? now, updated_at: now })
          .where("task_id", "=", row.task_id)
          .where("effect_id", "=", row.effect_id)
          .where("state", "=", "running")
          .where("claim_epoch", "=", row.claim_epoch),
      );
    } catch {
      return true;
    }
  }
  return found;
}

export function cancelUnstartedApprovalExecutions(
  db: DatabaseSync,
  grantId: string,
  now: number,
): void {
  const rows = executeSqliteQuerySync(
    db,
    dbx(db)
      .selectFrom("governor_action_intents")
      .selectAll()
      .where("state", "=", "running")
      .where("effect_started_at", "is", null),
  );
  for (const row of rows.rows) {
    let proposal: unknown;
    try {
      proposal = JSON.parse(row.proposal_json) as unknown;
    } catch {
      continue;
    }
    if (
      typeof proposal !== "object" ||
      proposal === null ||
      !("approvalGrantId" in proposal) ||
      proposal.approvalGrantId !== grantId
    ) {
      continue;
    }
    executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_action_intents")
        .set({
          state: "cancelled",
          cancelled_at: now,
          lease_expires_at: null,
          claim_epoch: (normalizeSqliteNumber(row.claim_epoch) ?? 0) + 1,
          updated_at: now,
        })
        .where("task_id", "=", row.task_id)
        .where("effect_id", "=", row.effect_id)
        .where("state", "=", "running")
        .where("claim_epoch", "=", row.claim_epoch)
        .where("updated_at", "=", row.updated_at),
    );
  }
}

export function markApprovalGrantRevoked(
  db: DatabaseSync,
  grantId: string,
  observedAt: number,
): void {
  executeSqliteQuerySync(
    db,
    dbx(db)
      .updateTable("governor_approval_grants")
      .set({ revoked_at: observedAt })
      .where("grant_id", "=", grantId),
  );
}
