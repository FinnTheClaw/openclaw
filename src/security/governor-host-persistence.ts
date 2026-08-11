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
import { initializeGovernorStateSchema } from "../tasks/governor/state-schema.js";
import {
  createGovernorHostAntiRollbackLedger,
  isGovernorHostAntiRollbackLedger,
  type GovernorHostAntiRollbackLedger,
  type GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";

type HostDb = Pick<
  StateDb,
  | "governor_approval_epochs"
  | "governor_approval_grants"
  | "governor_delivery_certification_epochs"
  | "governor_delivery_certifications"
>;
type DeliveryInput = Readonly<{
  handle: string;
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  signature: string;
  observedAt: number;
}>;
type DeliveryState = Readonly<{ generation: number; status: "certified" | "revoked" }>;

export type GovernorHostPersistence = {
  readonly recordApprovalGrant: (input: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
    observedAt: number;
  }) => GovernorLedgerState;
  readonly approvalGrantMatches: (input: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
  }) => boolean;
  readonly revokeApproval: (input: {
    grantId: string;
    scopeKey: string;
    observedAt: number;
  }) => boolean;
  readonly approvalEpoch: (scopeKey: string) => number;
  readonly deliveryHighWater: (identityKey: string) => GovernorLedgerState | null;
  readonly certifyDelivery: (input: DeliveryInput) => GovernorLedgerState;
  readonly deliveryBindingMatches: (
    input: DeliveryInput & { status: "certified" | "revoked" },
  ) => boolean;
  readonly revokeDelivery: (input: DeliveryInput) => boolean;
  readonly deliveryState: (identityKey: string) => DeliveryState | null;
};

const PORTS = new WeakSet<object>();
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<HostDb>(db);
const approvalScopeKey = (scopeKey: string) => governorDigest({ kind: "scope", scopeKey });
const approvalGrantKey = (scopeKey: string, grantId: string) =>
  governorDigest({ kind: "grant", scopeKey, grantId });

function deliveryBinding(input: DeliveryInput & { status: "certified" | "revoked" }): string {
  return governorDigest({
    handle: input.handle,
    identityKey: input.identityKey,
    implementationDigest: input.implementationDigest,
    configDigest: input.configDigest,
    generation: input.generation,
    status: input.status,
    signature: input.signature,
  });
}

export function isGovernorHostPersistence(value: GovernorHostPersistence): boolean {
  return PORTS.has(value);
}

/** Called only from trusted bootstrap; the ledger is a separate host sidecar. */
export function createGovernorHostPersistence(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  secrets?: GovernorSecrets;
  ledger?: GovernorHostAntiRollbackLedger;
  /** Test-only crash point for the ledger-first reconciliation contract. */
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

  const primaryApprovalEpoch = (scopeKey: string): number => {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_approval_epochs")
        .select("epoch")
        .where("scope_key", "=", scopeKey),
    );
    return normalizeSqliteNumber(row?.epoch ?? null) ?? 0;
  };

  const port: GovernorHostPersistence = Object.freeze({
    recordApprovalGrant: (input) => {
      if (!Number.isSafeInteger(input.approvalEpoch) || input.approvalEpoch < 0) {
        throw new Error("Governor approval ledger epoch is invalid");
      }
      const scopeKey = approvalScopeKey(input.scopeKey);
      const scope = ledger.state("approval", scopeKey);
      const primaryEpoch = primaryApprovalEpoch(input.scopeKey);
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
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_approval_epochs")
            .values({
              scope_key: input.scopeKey,
              epoch: input.approvalEpoch,
              updated_at: input.observedAt,
            })
            .onConflict((conflict) =>
              conflict.column("scope_key").doUpdateSet({
                epoch: input.approvalEpoch,
                updated_at: input.observedAt,
              }),
            ),
        );
      }, options);
      return grant;
    },
    approvalGrantMatches: (input) => {
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
    },
    revokeApproval: (input) => {
      const { db } = openOpenClawStateDatabase(options);
      const grant = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_approval_grants")
          .select(["scope_key", "approval_epoch"])
          .where("grant_id", "=", input.grantId),
      );
      if (!grant || grant.scope_key !== input.scopeKey) {
        return false;
      }
      const grantEpoch = normalizeSqliteNumber(grant.approval_epoch) ?? -1;
      const scopeKey = approvalScopeKey(input.scopeKey);
      const scope = ledger.state("approval", scopeKey);
      const grantState = ledger.state("approval", approvalGrantKey(input.scopeKey, input.grantId));
      if (
        !scope ||
        !grantState ||
        grantState.generation !== grantEpoch ||
        grantState.status !== "approved" ||
        !thisBindingMatches(
          grantState.bindingDigest,
          governorDigest({ scopeKey, grantId: input.grantId, epoch: grantEpoch }),
        )
      ) {
        throw new Error("Governor approval ledger state is missing or mismatched");
      }
      const primaryEpoch = primaryApprovalEpoch(input.scopeKey);
      if (primaryEpoch > scope.generation || grantEpoch > scope.generation) {
        throw new Error("Governor approval primary state is ahead of the host ledger");
      }
      let targetEpoch = scope.generation;
      if (scope.generation === grantEpoch) {
        targetEpoch = grantEpoch + 1;
        ledger.append({
          kind: "approval",
          key: scopeKey,
          generation: targetEpoch,
          status: "revoked",
          bindingDigest: governorDigest({ scopeKey, grantId: input.grantId, epoch: targetEpoch }),
        });
        params.testAfterLedgerAppend?.();
      }
      return runOpenClawStateWriteTransaction(({ db: tx }) => {
        executeSqliteQuerySync(
          tx,
          dbx(tx)
            .insertInto("governor_approval_epochs")
            .values({ scope_key: input.scopeKey, epoch: targetEpoch, updated_at: input.observedAt })
            .onConflict((c) =>
              c
                .column("scope_key")
                .doUpdateSet({ epoch: targetEpoch, updated_at: input.observedAt }),
            ),
        );
        const update = executeSqliteQuerySync(
          tx,
          dbx(tx)
            .updateTable("governor_approval_grants")
            .set({ revoked_at: input.observedAt })
            .where("grant_id", "=", input.grantId),
        );
        return update.numAffectedRows === 1n;
      }, options);
    },
    approvalEpoch: (scopeKey) =>
      ledger.state("approval", approvalScopeKey(scopeKey))?.generation ?? 0,
    deliveryHighWater: (identityKey) => ledger.state("delivery", identityKey),
    certifyDelivery: (input) => {
      const current = ledger.state("delivery", input.identityKey);
      const bindingDigest = deliveryBinding({ ...input, status: "certified" });
      if (
        current &&
        (input.generation < current.generation ||
          (input.generation === current.generation &&
            (current.status !== "certified" || current.bindingDigest !== bindingDigest)))
      ) {
        throw new Error("Governor delivery identity generation is durably stale");
      }
      return ledger.append({
        kind: "delivery",
        key: input.identityKey,
        generation: input.generation,
        status: "certified",
        bindingDigest,
      });
    },
    deliveryBindingMatches: (input) => {
      const state = ledger.state("delivery", input.identityKey);
      return (
        state?.generation === input.generation &&
        state.status === input.status &&
        state.bindingDigest === deliveryBinding(input)
      );
    },
    revokeDelivery: (input) => {
      const current = ledger.state("delivery", input.identityKey);
      if (!current) {
        throw new Error("Governor delivery ledger state is missing");
      }
      const bindingDigest = deliveryBinding({ ...input, status: "revoked" });
      if (input.generation < current.generation) {
        throw new Error("Governor delivery ledger generation regressed");
      }
      if (input.generation === current.generation) {
        if (current.status !== "revoked" || current.bindingDigest !== bindingDigest) {
          throw new Error("Governor delivery ledger binding conflicts at generation");
        }
      } else {
        ledger.append({
          kind: "delivery",
          key: input.identityKey,
          generation: input.generation,
          status: "revoked",
          bindingDigest,
        });
        params.testAfterLedgerAppend?.();
      }
      return runOpenClawStateWriteTransaction(({ db }) => {
        const epoch = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_certification_epochs")
            .select("generation")
            .where("identity_key", "=", input.identityKey),
        );
        if ((normalizeSqliteNumber(epoch?.generation ?? null) ?? -1) > input.generation) {
          throw new Error("Governor delivery primary state is ahead of the host ledger");
        }
        const persisted = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_certifications")
            .selectAll()
            .where("identity_key", "=", input.identityKey),
        );
        const persistedGeneration =
          normalizeSqliteNumber(persisted?.certification_generation ?? null) ?? -1;
        if (persistedGeneration > input.generation) {
          throw new Error("Governor delivery primary certification is ahead of the host ledger");
        }
        if (persistedGeneration === input.generation && persisted) {
          const matching =
            persisted.status === "revoked" &&
            persisted.implementation_digest === input.implementationDigest &&
            persisted.config_digest === input.configDigest &&
            persisted.authority_key_id === "host-broker-v1" &&
            normalizeSqliteNumber(persisted.authority_version) === 1 &&
            persisted.certification_signature === input.signature;
          if (!matching) {
            throw new Error("Governor delivery primary binding does not match the host ledger");
          }
        }
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_delivery_certification_epochs")
            .values({
              identity_key: input.identityKey,
              generation: input.generation,
              updated_at: input.observedAt,
            })
            .onConflict((c) =>
              c
                .column("identity_key")
                .doUpdateSet({ generation: input.generation, updated_at: input.observedAt }),
            ),
        );
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_delivery_certifications")
            .values({
              identity_key: input.identityKey,
              status: "revoked",
              implementation_digest: input.implementationDigest,
              config_digest: input.configDigest,
              certification_generation: input.generation,
              authority_key_id: "host-broker-v1",
              authority_version: 1,
              certification_signature: input.signature,
              created_at: input.observedAt,
              revoked_at: input.observedAt,
            })
            .onConflict((c) =>
              c.column("identity_key").doUpdateSet({
                status: "revoked",
                implementation_digest: input.implementationDigest,
                config_digest: input.configDigest,
                certification_generation: input.generation,
                authority_key_id: "host-broker-v1",
                authority_version: 1,
                certification_signature: input.signature,
                revoked_at: input.observedAt,
              }),
            ),
        );
        return true;
      }, options);
    },
    deliveryState: (identityKey) => {
      const state = ledger.state("delivery", identityKey);
      if (!state || (state.status !== "certified" && state.status !== "revoked")) {
        return null;
      }
      return { generation: state.generation, status: state.status };
    },
  });
  PORTS.add(port);
  return port;
}

function thisBindingMatches(actual: string, expected: string): boolean {
  return actual === expected;
}
