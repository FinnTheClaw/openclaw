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
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedJson } from "../tasks/governor/persistence-guard.js";
import { initializeGovernorStateSchema } from "../tasks/governor/state-schema.js";
import { GovernorStoreLifecycle } from "../tasks/governor/store-lifecycle.js";
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
  createGovernorMemoryAuthority,
  type GovernorTrustedMemoryAuthority,
} from "./governor-host-memory-authority.js";
import {
  createGovernorOwnerIngressPersistence,
  type GovernorOwnerIngressPersistence,
} from "./governor-host-owner-ingress-persistence.js";
import {
  createGovernorPhysicalExecutionCoordinator,
  type GovernorTrustedPhysicalExecutionCoordinator,
} from "./governor-host-physical-execution.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";
import {
  createGovernorTaskAuthority,
  type GovernorTrustedTaskAuthority,
} from "./governor-host-task-authority.js";

type ApprovalDb = Pick<
  StateDb,
  "governor_action_intents" | "governor_approval_epochs" | "governor_approval_grants"
>;
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<ApprovalDb>(db);
const approvalScopeKey = (scopeKey: string) => governorDigest({ kind: "scope", scopeKey });
const approvalGrantKey = (scopeKey: string, grantId: string) =>
  governorDigest({ kind: "grant", scopeKey, grantId });

function governorPrimaryHasDurableState(options: OpenClawStateDatabaseOptions): boolean {
  const { db } = openOpenClawStateDatabase(options);
  const tables =
    // sqlite-allow-raw: closed sqlite_schema inventory before governor schema bootstrap
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'governor_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (!/^governor_[a-z0-9_]+$/u.test(name)) {
      throw new Error("GOVERNOR_PRIMARY_SCHEMA_INVALID");
    }
    const present =
      // sqlite-allow-raw: validated closed governor table name
      db.prepare(`SELECT 1 AS present FROM "${name}" LIMIT 1`).get();
    if (present) {
      return true;
    }
  }
  return false;
}

export type GovernorHostPersistence = Readonly<{
  close: () => void;
  physicalExecutions: GovernorTrustedPhysicalExecutionCoordinator;
  memoryAuthority: GovernorTrustedMemoryAuthority;
  taskAuthority: GovernorTrustedTaskAuthority;
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

function requestStartedApprovalCancellation(
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

function cancelUnstartedApprovalExecutions(db: DatabaseSync, grantId: string, now: number): void {
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

/** Called only from trusted bootstrap; the ledger is a separate host sidecar. */
export function createGovernorHostPersistence(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  secrets?: GovernorSecrets;
  ledger?: GovernorHostAntiRollbackLedger;
  testAfterLedgerAppend?: () => void;
  testClose?: () => void;
  testMode?: boolean;
  lifecycle?: GovernorStoreLifecycle;
}): GovernorHostPersistence {
  if (params.testAfterLedgerAppend && params.testMode !== true) {
    throw new Error("Governor host persistence test hooks are unavailable outside tests");
  }
  if (params.testClose && params.testMode !== true) {
    throw new Error("Governor host persistence test hooks are unavailable outside tests");
  }
  if (params.secrets && !isGovernorSecrets(params.secrets)) {
    throw new Error("Governor host persistence requires validated governor secrets");
  }
  const baseOptions: OpenClawStateDatabaseOptions = {
    env: {
      ...params.env,
      ...(params.stateDir ? { OPENCLAW_STATE_DIR: params.stateDir } : {}),
    },
  };
  const lifecycle = params.lifecycle ?? new GovernorStoreLifecycle(baseOptions);
  const options: OpenClawStateDatabaseOptions = { ...baseOptions, lifecycle };
  const ledgerKey = params.secrets?.ledgerSigningKey;
  if (!params.ledger && !ledgerKey?.trim()) {
    throw new Error("Governor host anti-rollback ledger signing key is required");
  }
  const stateDatabase = openOpenClawStateDatabase(options);
  const stateDb = stateDatabase.db;
  const schemaHasGovernorTables = Boolean(
    // sqlite-allow-raw: closed sqlite_schema existence probe before trust-root creation
    stateDb
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name LIKE 'governor_%' LIMIT 1",
      )
      .get(),
  );
  const primaryHasDurableState = schemaHasGovernorTables
    ? governorPrimaryHasDurableState(options)
    : false;
  const ledger =
    params.ledger ??
    createGovernorHostAntiRollbackLedger({
      stateDir: resolveOpenClawStateSqliteDir(options.env),
      signingKey: ledgerKey as string,
      allowInitialization: !primaryHasDurableState,
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
    close: () => {
      const errors: unknown[] = [];
      try {
        params.testClose?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        lifecycle.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "GOVERNOR_HOST_PERSISTENCE_CLOSE_FAILED");
      }
    },
    physicalExecutions: createGovernorPhysicalExecutionCoordinator(ledger),
    memoryAuthority: createGovernorMemoryAuthority(ledger, params.testAfterLedgerAppend),
    taskAuthority: createGovernorTaskAuthority(ledger, params.testAfterLedgerAppend),
    ...createGovernorOwnerIngressPersistence(options, ledger),
    ...createGovernorHostDeliveryPersistence({
      options,
      ledger,
      ...(params.testAfterLedgerAppend
        ? { testAfterLedgerAppend: params.testAfterLedgerAppend }
        : {}),
    }),
    recordApprovalGrant: (input) => {
      assertGovernorPersistedJson("log", input);
      return runOpenClawStateWriteTransaction(({ db }) => {
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
      }, options);
    },
    approvalLedgerMatches,
    approvalGrantMatches: (input) => {
      assertGovernorPersistedJson("log", input);
      const primaryMatches = runOpenClawStateWriteTransaction(
        ({ db }) => primaryApprovalEpoch(db, input.scopeKey) === input.approvalEpoch,
        options,
      );
      return primaryMatches && approvalLedgerMatches(input);
    },
    revokeApproval: (input) => {
      assertGovernorPersistedJson("log", input);
      return runOpenClawStateWriteTransaction(({ db }) => {
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
        // Always reconcile the primary action rows, including an idempotent
        // retry after a ledger-first crash rolled the SQLite transaction back.
        if (requestStartedApprovalCancellation(db, input.grantId, input.observedAt)) {
          return false;
        }
        cancelUnstartedApprovalExecutions(db, input.grantId, input.observedAt);
        if (grant.status === "approved" && scope.status === "approved") {
          // The external-effect fence, not a worker lease alone, is the
          // execution linearization point. A started effect remains in flight
          // until the host acknowledges its physical termination.
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
      }, options);
    },
    approvalEpoch: (scopeKey) => {
      assertGovernorPersistedJson("log", { scopeKey });
      return ledger.state("approval", approvalScopeKey(scopeKey))?.generation ?? 0;
    },
  });
  PORTS.add(port);
  return port;
}
