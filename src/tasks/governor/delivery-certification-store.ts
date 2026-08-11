// Persists host-signed registration certifications with monotonic generations.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  governorDeliveryRegistrationKey,
  GovernorHostDeliveryCertificationAuthority,
  type GovernorRegisteredDeliveryAdapter,
} from "./delivery-certification.js";
import { initializeGovernorStateSchema } from "./state-schema.js";

type CertificationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_delivery_certifications" | "governor_delivery_certification_epochs"
>;
type CertificationTable = OpenClawStateKyselyDatabase["governor_delivery_certifications"];
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<CertificationDatabase>(db);

export class GovernorDeliveryCertificationStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #authority: GovernorHostDeliveryCertificationAuthority;
  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
    this.#authority = GovernorHostDeliveryCertificationAuthority.fromEnvironment();
  }

  certifyHostRegistration(adapter: GovernorRegisteredDeliveryAdapter, now: number): void {
    this.#write(adapter, "certified", now);
  }
  revokeHostRegistration(adapter: GovernorRegisteredDeliveryAdapter, now: number): void {
    this.#write(adapter, "revoked", now);
  }

  assertCertified(adapter: GovernorRegisteredDeliveryAdapter): void {
    const registrationKey = governorDeliveryRegistrationKey(adapter);
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_delivery_certifications")
        .selectAll()
        .where("identity_key", "=", registrationKey),
    );
    const epoch = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_delivery_certification_epochs")
        .selectAll()
        .where("identity_key", "=", registrationKey),
    );
    if (!row || !epoch) {
      throw new Error("Governor delivery adapter is uncertified");
    }
    const generation = normalizeSqliteNumber(row.certification_generation) ?? -1;
    if ((normalizeSqliteNumber(epoch.generation) ?? -1) !== generation) {
      throw new Error("Governor delivery certification is stale");
    }
    const valid = this.#authority.verifies({
      registrationKey,
      status: row.status === "certified" ? "certified" : "revoked",
      generation,
      keyId: row.authority_key_id,
      version: normalizeSqliteNumber(row.authority_version) ?? 0,
      signature: row.certification_signature,
    });
    if (!valid) {
      throw new Error("Governor delivery adapter certification signature is invalid");
    }
    if (
      row.status !== "certified" ||
      row.revoked_at !== null ||
      row.implementation_digest !== adapter.implementationDigest ||
      row.config_digest !== adapter.configDigest
    ) {
      throw new Error("Governor delivery adapter is revoked");
    }
  }

  #write(
    adapter: GovernorRegisteredDeliveryAdapter,
    status: "certified" | "revoked",
    now: number,
  ): void {
    const registrationKey = governorDeliveryRegistrationKey(adapter);
    runOpenClawStateWriteTransaction(({ db }) => {
      const old = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certification_epochs")
          .selectAll()
          .where("identity_key", "=", registrationKey),
      );
      const generation = (normalizeSqliteNumber(old?.generation) ?? -1) + 1;
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_delivery_certification_epochs")
          .values({ identity_key: registrationKey, generation, updated_at: now })
          .onConflict((c) => c.column("identity_key").doUpdateSet({ generation, updated_at: now })),
      );
      const row: Insertable<CertificationTable> = {
        identity_key: registrationKey,
        status,
        implementation_digest: adapter.implementationDigest,
        config_digest: adapter.configDigest,
        certification_generation: generation,
        authority_key_id: this.#authority.keyId,
        authority_version: 1,
        certification_signature: this.#authority.sign({
          registrationKey,
          status,
          generation,
          keyId: this.#authority.keyId,
          version: 1,
        }),
        created_at: now,
        revoked_at: status === "revoked" ? now : null,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_delivery_certifications")
          .values(row)
          .onConflict((c) => c.column("identity_key").doUpdateSet(row)),
      );
    }, this.#options);
  }
}
