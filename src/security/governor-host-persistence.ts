/** Host-only primary-state reconciliation behind the V9 anti-rollback ledger. */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as StateDb } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { initializeGovernorStateSchema } from "../tasks/governor/state-schema.js";
import {
  createGovernorHostAntiRollbackLedger,
  isGovernorHostAntiRollbackLedger,
  type GovernorHostAntiRollbackLedger,
  type GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";
import {
  createGovernorHostDeliveryPersistence,
  type GovernorHostDeliveryPersistence,
} from "./governor-host-delivery-persistence.js";
import {
  createGovernorOwnerIngressPersistence,
  type GovernorOwnerIngressPersistence,
} from "./governor-host-owner-ingress-persistence.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";

type ApprovalDb = Pick<
  StateDb,
  "governor_action_intents" | "governor_approval_epochs" | "governor_approval_grants"
>;
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<ApprovalDb>(db);
const approvalScopeKey = (scopeKey: string) => governorDigest({ kind: "scope", scopeKey });
const approvalGrantKey = (scopeKey: string, grantId: string) =>
  governorDigest({ kind: "grant", scopeKey, grantId });

export type GovernorHostPersistence = Readonly<{
  recordApprovalGrant: (input: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
    observedAt: number;
  }) => GovernorLedgerState;
  approvalGrantMatches: (input: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
  }) => boolean;
  approvalLedgerMatches: (input: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
  }) => boolean;
  revokeApproval: (input: { grantId: string; scopeKey: string; observedAt: number }) => boolean;
  approvalEpoch: (scopeKey: string) => number;
}> &
  GovernorHostDeliveryPersistence &
  GovernorOwnerIngressPersistence;

const PORTS = new WeakSet<object>();

export function isGovernorHostPersistence(value: GovernorHostPersistence): boolean {
  return PORTS.has(value);
}

function primaryApprovalEpoch(db: DatabaseSync, scopeKey: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_approval_epochs")
      .select("epoch")
      .where("scope_key", "=", scopeKey),
  );
  return normalizeSqliteNumber(row?.epoch ?? null) ?? 0;
}

function writeApprovalEpoch(
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

function hasLiveApprovalExecution(db: DatabaseSync, grantId: string, now: number): boolean {
  const rows = executeSqliteQuerySync(
    db,
    dbx(db)
      .selectFrom("governor_action_intents")
      .select(["approval_required", "proposal_json"])
      .where("state", "=", "running")
      .where("lease_expires_at", ">", now),
  );
  return rows.rows.some((row) => {
    try {
      const proposal = JSON.parse(row.proposal_json) as unknown;
      if (typeof proposal !== "object" || proposal === null) {
        return true;
      }
      if (!("approvalGrantId" in proposal)) {
        return normalizeSqliteNumber(row.approval_required) === 1;
      }
      return proposal.approvalGrantId === grantId;
    } catch {
      // A malformed live intent cannot be proven unrelated to the grant. Keep
      // revocation fail-closed until the execution lease is reconciled.
      return true;
    }
  });
}

/** Called only from trusted bootstrap; the ledger is a separate host sidecar. */
export function createGovernorHostPersistence(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  secrets?: GovernorSecrets;
  ledger?: GovernorHostAntiRollbackLedger;
  testAfterLedgerAppend?: () => void;
  testMode?: boolean;
}): GovernorHostPersistence {
  if (params.testAfterLedgerAppend && params.testMode !== true) {
    throw new Error("Governor host persistence test hooks are unavailable outside tests");
  }
  if (params.secrets && !isGovernorSecrets(params.secrets)) {
    throw new Error("Governor host persistence requires validated governor secrets");
  }
  const options: OpenClawStateDatabaseOptions = {
    env: {
      ...params.env,
      ...(params.stateDir ? { OPENCLAW_STATE_DIR: params.stateDir } : {}),
    },
  };
  const ledgerKey = params.secrets?.ledgerSigningKey;
  if (!params.ledger && !ledgerKey?.trim()) {
    throw new Error("Governor host anti-rollback ledger signing key is required");
  }
  const ledger =
    params.ledger ??
    createGovernorHostAntiRollbackLedger({
      stateDir: resolveOpenClawStateSqliteDir(options.env),
      signingKey: ledgerKey as string,
    });
  if (!isGovernorHostAntiRollbackLedger(ledger)) {
    throw new Error("Governor host anti-rollback ledger capability is invalid");
  }
  initializeGovernorStateSchema(options);

  const approvalLedgerMatches: GovernorHostPersistence["approvalLedgerMatches"] = (input) => {
    const scopeKey = approvalScopeKey(input.scopeKey);
    const scope = ledger.state("approval", scopeKey);
    const grant = ledger.state("approval", approvalGrantKey(input.scopeKey, input.grantId));
    return (
      scope?.generation === input.approvalEpoch &&
      scope.status === "approved" &&
      grant?.generation === input.approvalEpoch &&
      grant.status === "approved" &&
      grant.bindingDigest ===
        governorDigest({ scopeKey, grantId: input.grantId, epoch: input.approvalEpoch })
    );
  };

  const port: GovernorHostPersistence = Object.freeze({
    ...createGovernorOwnerIngressPersistence(options, ledger),
    ...createGovernorHostDeliveryPersistence({
      options,
      ledger,
      ...(params.testAfterLedgerAppend
        ? { testAfterLedgerAppend: params.testAfterLedgerAppend }
        : {}),
    }),
    recordApprovalGrant: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        if (!Number.isSafeInteger(input.approvalEpoch) || input.approvalEpoch < 0) {
          throw new Error("Governor approval ledger epoch is invalid");
        }
        const scopeKey = approvalScopeKey(input.scopeKey);
        const scope = ledger.state("approval", scopeKey);
        const primaryEpoch = primaryApprovalEpoch(db, input.scopeKey);
        if (primaryEpoch > input.approvalEpoch) {
          throw new Error("Governor approval primary state is ahead of the host ledger");
        }
        if (!scope) {
          if (input.approvalEpoch !== 0) {
            throw new Error("Governor initial approval ledger epoch must be zero");
          }
          ledger.append({
            kind: "approval",
            key: scopeKey,
            generation: input.approvalEpoch,
            status: "approved",
            bindingDigest: governorDigest({ scopeKey, generation: input.approvalEpoch }),
          });
        } else if (input.approvalEpoch === scope.generation + 1) {
          ledger.append({
            kind: "approval",
            key: scopeKey,
            generation: input.approvalEpoch,
            status: "approved",
            bindingDigest: governorDigest({ scopeKey, generation: input.approvalEpoch }),
          });
        } else if (
          scope.generation !== input.approvalEpoch ||
          scope.status !== "approved" ||
          scope.bindingDigest !== governorDigest({ scopeKey, generation: input.approvalEpoch })
        ) {
          throw new Error("Governor approval ledger epoch is stale");
        }
        const grant = ledger.append({
          kind: "approval",
          key: approvalGrantKey(input.scopeKey, input.grantId),
          generation: input.approvalEpoch,
          status: "approved",
          bindingDigest: governorDigest({
            scopeKey,
            grantId: input.grantId,
            epoch: input.approvalEpoch,
          }),
        });
        writeApprovalEpoch(db, input.scopeKey, input.approvalEpoch, input.observedAt);
        return grant;
      }, options),
    approvalLedgerMatches,
    approvalGrantMatches: (input) => {
      const primaryMatches = runOpenClawStateWriteTransaction(
        ({ db }) => primaryApprovalEpoch(db, input.scopeKey) === input.approvalEpoch,
        options,
      );
      return primaryMatches && approvalLedgerMatches(input);
    },
    revokeApproval: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const scopeKey = approvalScopeKey(input.scopeKey);
        const scope = ledger.state("approval", scopeKey);
        const grantKey = approvalGrantKey(input.scopeKey, input.grantId);
        const grant = ledger.state("approval", grantKey);
        if (!scope || !grant || (grant.status !== "approved" && grant.status !== "revoked")) {
          return false;
        }
        if (primaryApprovalEpoch(db, input.scopeKey) > scope.generation) {
          throw new Error("Governor approval primary state is ahead of the host ledger");
        }
        let targetEpoch = Math.max(scope.generation, grant.generation);
        if (grant.status === "approved" && scope.status === "approved") {
          // Action claim and revocation share this SQLite write lock. If claim
          // linearized first, revocation truthfully reports that authority is
          // still in flight instead of claiming success before an effect starts.
          if (hasLiveApprovalExecution(db, input.grantId, input.observedAt)) {
            return false;
          }
          targetEpoch += 1;
          ledger.append({
            kind: "approval",
            key: scopeKey,
            generation: targetEpoch,
            status: "revoked",
            bindingDigest: governorDigest({ scopeKey, grantId: input.grantId, epoch: targetEpoch }),
          });
          params.testAfterLedgerAppend?.();
        }
        if (grant.status === "approved") {
          ledger.append({
            kind: "approval",
            key: grantKey,
            generation: targetEpoch,
            status: "revoked",
            bindingDigest: governorDigest({
              scopeKey,
              grantId: input.grantId,
              epoch: targetEpoch,
              status: "revoked",
            }),
          });
        }
        writeApprovalEpoch(db, input.scopeKey, targetEpoch, input.observedAt);
        executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_approval_grants")
            .set({ revoked_at: input.observedAt })
            .where("grant_id", "=", input.grantId),
        );
        return true;
      }, options),
    approvalEpoch: (scopeKey) =>
      ledger.state("approval", approvalScopeKey(scopeKey))?.generation ?? 0,
  });
  PORTS.add(port);
  return port;
}
