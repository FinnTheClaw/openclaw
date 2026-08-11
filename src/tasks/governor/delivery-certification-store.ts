// Verifies broker-bound delivery handles and durably fences revoked generations.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  isTrustedGovernorDeliveryResolver,
  type GovernorTrustedDeliveryResolver,
  type HostGovernorDeliveryHandle,
} from "../../security/governor-host-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { initializeGovernorStateSchema } from "./state-schema.js";

type CertificationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_delivery_certifications" | "governor_delivery_certification_epochs"
>;
type CertificationTable = OpenClawStateKyselyDatabase["governor_delivery_certifications"];
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<CertificationDatabase>(db);

export class GovernorDeliveryCertificationStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #resolver: GovernorTrustedDeliveryResolver;

  constructor(params: { stateDir?: string; deliveryResolver: GovernorTrustedDeliveryResolver }) {
    if (!isTrustedGovernorDeliveryResolver(params.deliveryResolver)) {
      throw new Error("Governor delivery store requires a trusted host delivery resolver");
    }
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
    this.#resolver = params.deliveryResolver;
  }

  resolveCertified(handle: HostGovernorDeliveryHandle) {
    const adapter = this.#resolver.resolve(handle);
    if (!adapter) {
      throw new Error("Governor delivery adapter handle is not host-registered");
    }
    // Stable identity, rather than a generation-specific handle, fences a
    // restarted host bootstrap from resurrecting a revoked old generation.
    const registrationKey = adapter.identityKey;
    runOpenClawStateWriteTransaction(({ db }) => {
      const current = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certification_epochs")
          .selectAll()
          .where("identity_key", "=", registrationKey),
      );
      const currentGeneration = normalizeSqliteNumber(current?.generation ?? null) ?? -1;
      if (adapter.generation < currentGeneration) {
        throw new Error("Governor delivery adapter certification is stale");
      }
      const persisted = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certifications")
          .selectAll()
          .where("identity_key", "=", registrationKey),
      );
      if (persisted && adapter.generation === currentGeneration) {
        const valid =
          persisted.status === adapter.status &&
          persisted.implementation_digest === adapter.implementationDigest &&
          persisted.config_digest === adapter.configDigest &&
          (normalizeSqliteNumber(persisted.certification_generation) ?? -1) ===
            adapter.generation &&
          persisted.authority_key_id === "host-broker-v1" &&
          (normalizeSqliteNumber(persisted.authority_version) ?? -1) === 1 &&
          persisted.certification_signature === adapter.signature;
        if (!valid) {
          throw new Error("Governor delivery certification signature is invalid");
        }
      }
      if (adapter.status === "certified" && adapter.generation === currentGeneration) {
        return;
      }
      const row: Insertable<CertificationTable> = {
        identity_key: registrationKey,
        status: adapter.status,
        implementation_digest: adapter.implementationDigest,
        config_digest: adapter.configDigest,
        certification_generation: adapter.generation,
        authority_key_id: "host-broker-v1",
        authority_version: 1,
        certification_signature: adapter.signature,
        created_at: Date.now(),
        revoked_at: adapter.status === "revoked" ? Date.now() : null,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_delivery_certification_epochs")
          .values({
            identity_key: registrationKey,
            generation: adapter.generation,
            updated_at: Date.now(),
          })
          .onConflict((c) =>
            c
              .column("identity_key")
              .doUpdateSet({ generation: adapter.generation, updated_at: Date.now() }),
          ),
      );
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_delivery_certifications")
          .values(row)
          .onConflict((c) => c.column("identity_key").doUpdateSet(row)),
      );
    }, this.#options);
    if (adapter.status !== "certified") {
      throw new Error("Governor delivery adapter is revoked");
    }
    return adapter;
  }
}
