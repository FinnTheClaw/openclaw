/**
 * Durable host-only revocation port for the experimental governor.
 *
 * The broker owns its object capability; this module owns the SQLite
 * transaction. Task-facing code receives neither.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { initializeGovernorStateSchema } from "../tasks/governor/state-schema.js";

type HostPersistenceDatabase = Pick<
  OpenClawStateDatabase,
  | "governor_approval_epochs"
  | "governor_approval_grants"
  | "governor_delivery_certification_epochs"
  | "governor_delivery_certifications"
>;
type PersistedDeliveryRevocation = Readonly<{
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  signature: string;
  observedAt: number;
}>;
type DurableDeliveryState = Readonly<{ generation: number; status: "certified" | "revoked" }>;

export type GovernorHostPersistence = {
  readonly revokeApproval: (input: {
    grantId: string;
    scopeKey: string;
    observedAt: number;
  }) => boolean;
  readonly approvalEpoch: (scopeKey: string) => number;
  readonly revokeDelivery: (input: PersistedDeliveryRevocation) => boolean;
  readonly deliveryState: (identityKey: string) => DurableDeliveryState | null;
};

const PORTS = new WeakSet<object>();
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<HostPersistenceDatabase>(db);

export function isGovernorHostPersistence(value: GovernorHostPersistence): boolean {
  return PORTS.has(value);
}

/** Called only from trusted application bootstrap. */
export function createGovernorHostPersistence(
  params: { stateDir?: string } = {},
): GovernorHostPersistence {
  const options: OpenClawStateDatabaseOptions = params.stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
    : {};
  initializeGovernorStateSchema(options);
  const port: GovernorHostPersistence = Object.freeze({
    revokeApproval: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const grant = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_approval_grants")
            .select(["scope_key", "approval_epoch", "revoked_at"])
            .where("grant_id", "=", input.grantId),
        );
        if (!grant || grant.scope_key !== input.scopeKey || grant.revoked_at != null) {
          return false;
        }
        const current = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_approval_epochs")
            .select("epoch")
            .where("scope_key", "=", input.scopeKey),
        );
        const nextEpoch = Math.max(
          normalizeSqliteNumber(current?.epoch ?? null) ?? 0,
          (normalizeSqliteNumber(grant.approval_epoch) ?? 0) + 1,
        );
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_approval_epochs")
            .values({ scope_key: input.scopeKey, epoch: nextEpoch, updated_at: input.observedAt })
            .onConflict((c) =>
              c.column("scope_key").doUpdateSet({ epoch: nextEpoch, updated_at: input.observedAt }),
            ),
        );
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_approval_grants")
            .set({ revoked_at: input.observedAt })
            .where("grant_id", "=", input.grantId)
            .where("revoked_at", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options),
    approvalEpoch: (scopeKey) => {
      const { db } = openOpenClawStateDatabase(options);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_approval_epochs")
          .select("epoch")
          .where("scope_key", "=", scopeKey),
      );
      return normalizeSqliteNumber(row?.epoch ?? null) ?? 0;
    },
    revokeDelivery: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const current = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_certification_epochs")
            .select("generation")
            .where("identity_key", "=", input.identityKey),
        );
        const currentGeneration = normalizeSqliteNumber(current?.generation ?? null) ?? -1;
        if (input.generation <= currentGeneration) {
          return false;
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
              c.column("identity_key").doUpdateSet({
                generation: input.generation,
                updated_at: input.observedAt,
              }),
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
      }, options),
    deliveryState: (identityKey) => {
      const { db } = openOpenClawStateDatabase(options);
      const epoch = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certification_epochs")
          .select("generation")
          .where("identity_key", "=", identityKey),
      );
      if (!epoch) {
        return null;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certifications")
          .select("status")
          .where("identity_key", "=", identityKey),
      );
      const status = row?.status === "certified" ? "certified" : "revoked";
      return { generation: normalizeSqliteNumber(epoch.generation) ?? -1, status };
    },
  });
  PORTS.add(port);
  return port;
}
