/** Host-only primary-state reconciliation behind the V9 anti-rollback ledger. */
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedJson } from "../tasks/governor/persistence-guard.js";
import { assertGovernorJsonResources } from "../tasks/governor/resource-guard.js";
import { assertGovernorBoundarySafe } from "../tasks/governor/secret-filter.js";
import { initializeGovernorStateSchema } from "../tasks/governor/state-schema.js";
import { GovernorStoreLifecycle } from "../tasks/governor/store-lifecycle.js";
import {
  createGovernorHostAntiRollbackLedger,
  isGovernorHostAntiRollbackLedger,
  type GovernorHostAntiRollbackLedger,
  type GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";
import {
  approvalGrantKey,
  approvalScopeKey,
  cancelUnstartedApprovalExecutions,
  markApprovalGrantRevoked,
  primaryApprovalEpoch,
  requestStartedApprovalCancellation,
  writeApprovalEpoch,
} from "./governor-host-approval-persistence-helpers.js";
import {
  createGovernorHostDeliveryPersistence,
  type GovernorHostDeliveryPersistence,
} from "./governor-host-delivery-persistence.js";
import type {
  GovernorMemoryAuthorityAdvance,
  GovernorMemoryAuthorityBinding,
  GovernorMemoryAuthorityState,
  GovernorTrustedMemoryAuthority,
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

const MEMORY_AUTHORITIES = new WeakSet<object>();

export function isTrustedGovernorMemoryAuthority(value: GovernorTrustedMemoryAuthority): boolean {
  return MEMORY_AUTHORITIES.has(value);
}

function memoryAuthorityKey(scopeKey: string, factKey: string) {
  return governorDigest({ kind: "memory-fact", scopeKey, factKey });
}

function memoryAuthorityBinding(binding: GovernorMemoryAuthorityBinding) {
  return governorDigest(
    assertGovernorBoundarySafe(
      "memory",
      assertGovernorJsonResources({ kind: "memory-current", ...binding }),
    ),
  );
}

function memoryAuthorityState(
  state: GovernorLedgerState | null,
): GovernorMemoryAuthorityState | null {
  if (!state || (state.status !== "memory_current" && state.status !== "memory_retired")) {
    return null;
  }
  return {
    generation: state.generation,
    status: state.status === "memory_current" ? "current" : "retired",
    bindingDigest: state.bindingDigest,
    ledgerDigest: state.digest,
    ...(state.ordering ? { ordering: state.ordering } : {}),
  };
}

function rejectMemoryAdvance(
  current: GovernorLedgerState,
  binding: GovernorMemoryAuthorityBinding,
): Exclude<GovernorMemoryAuthorityAdvance, { accepted: true }> | null {
  const state = memoryAuthorityState(current) as GovernorMemoryAuthorityState;
  const prior = current.ordering;
  const next = binding.ordering;
  if (!prior) {
    return { accepted: false, state, reason: "legacy_high_water" };
  }
  if (next.scopeEpoch < prior.scopeEpoch || next.observedAt < prior.observedAt) {
    return { accepted: false, state, reason: "stale" };
  }
  if (current.status === "memory_retired" && next.scopeEpoch <= prior.scopeEpoch) {
    return { accepted: false, state, reason: "retired" };
  }
  if (
    next.taskDigest === prior.taskDigest &&
    (next.objectiveRevision < prior.objectiveRevision ||
      (next.objectiveRevision === prior.objectiveRevision &&
        next.planVersion < prior.planVersion) ||
      (next.objectiveRevision === prior.objectiveRevision &&
        next.planVersion === prior.planVersion &&
        next.taskVersion < prior.taskVersion))
  ) {
    return { accepted: false, state, reason: "fence_regression" };
  }
  if (
    next.scopeEpoch === prior.scopeEpoch &&
    (next.sourceRank < prior.sourceRank ||
      (next.sourceRank === prior.sourceRank &&
        next.confidenceMillionths < prior.confidenceMillionths))
  ) {
    return { accepted: false, state, reason: "weaker" };
  }
  if (
    next.scopeEpoch === prior.scopeEpoch &&
    next.observedAt === prior.observedAt &&
    next.sourceRank === prior.sourceRank &&
    next.confidenceMillionths === prior.confidenceMillionths
  ) {
    return { accepted: false, state, reason: "stale" };
  }
  return null;
}

function createMemoryAuthorityOwner(
  ledger: GovernorHostAntiRollbackLedger,
  afterLedgerAppend?: () => void,
): { authority: GovernorTrustedMemoryAuthority; close: () => void } {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  };
  const authority: GovernorTrustedMemoryAuthority = Object.freeze({
    advance: (binding) => {
      assertOpen();
      const digest = memoryAuthorityBinding(binding);
      const key = memoryAuthorityKey(binding.scopeKey, binding.factKey);
      const current = ledger.state("memory", key);
      if (current?.status === "memory_current" && current.bindingDigest === digest) {
        return { accepted: true, state: memoryAuthorityState(current)! };
      }
      if (current) {
        const rejection = rejectMemoryAdvance(current, binding);
        if (rejection) {
          return rejection;
        }
      }
      const next = ledger.append({
        kind: "memory",
        key,
        generation: (current?.generation ?? 0) + 1,
        status: "memory_current",
        bindingDigest: digest,
        ordering: binding.ordering,
      });
      afterLedgerAppend?.();
      return { accepted: true, state: memoryAuthorityState(next)! };
    },
    retire: (binding) => {
      assertOpen();
      assertGovernorBoundarySafe("memory", assertGovernorJsonResources(binding));
      const key = memoryAuthorityKey(binding.scopeKey, binding.factKey);
      const digest = governorDigest({ kind: "memory-retired", ...binding });
      const current = ledger.state("memory", key);
      if (current?.status === "memory_retired" && current.bindingDigest === digest) {
        return memoryAuthorityState(current)!;
      }
      if (
        current &&
        (current.status !== "memory_current" ||
          current.bindingDigest !== memoryAuthorityBinding(binding))
      ) {
        throw new Error("Governor memory retirement does not match current host authority");
      }
      const next = ledger.append({
        kind: "memory",
        key,
        generation: (current?.generation ?? 0) + 1,
        status: "memory_retired",
        bindingDigest: digest,
        ordering: binding.ordering,
      });
      afterLedgerAppend?.();
      return memoryAuthorityState(next)!;
    },
    state: (scopeKey, factKey) => {
      assertOpen();
      return memoryAuthorityState(ledger.state("memory", memoryAuthorityKey(scopeKey, factKey)));
    },
    matches: (binding, generation, bindingDigest) => {
      assertOpen();
      const expectedBinding = memoryAuthorityBinding(binding);
      const current = ledger.state("memory", memoryAuthorityKey(binding.scopeKey, binding.factKey));
      return (
        current?.status === "memory_current" &&
        current.generation === generation &&
        current.bindingDigest === bindingDigest &&
        bindingDigest === expectedBinding
      );
    },
  });
  MEMORY_AUTHORITIES.add(authority);
  return { authority, close: () => (closed = true) };
}

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

  const memoryAuthorityOwner = createMemoryAuthorityOwner(ledger, params.testAfterLedgerAppend);
  const port: GovernorHostPersistence = Object.freeze({
    close: () => {
      const errors: unknown[] = [];
      try {
        params.testClose?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        memoryAuthorityOwner.close();
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
    memoryAuthority: memoryAuthorityOwner.authority,
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
        markApprovalGrantRevoked(db, input.grantId, input.observedAt);
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
