// Persists only host-signed delivery adapter certifications and revocations.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  governorDeliveryIdentityKey,
  GovernorHostDeliveryCertificationAuthority,
  type GovernorDeliveryAdapterIdentity,
} from "./delivery-certification.js";
import { initializeGovernorStateSchema } from "./state-schema.js";

type CertificationDatabase = Pick<OpenClawStateKyselyDatabase, "governor_delivery_certifications">;
type CertificationTable = OpenClawStateKyselyDatabase["governor_delivery_certifications"];
type CertificationRow = Selectable<CertificationTable>;

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<CertificationDatabase>(db);
}

function bind(row: CertificationRow): Insertable<CertificationTable> {
  return { ...row };
}

export class GovernorDeliveryCertificationStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
  }

  hostCertify(params: {
    authority: GovernorHostDeliveryCertificationAuthority;
    identity: GovernorDeliveryAdapterIdentity;
    now: number;
  }): void {
    this.#write(params, "certified");
  }

  hostRevoke(params: {
    authority: GovernorHostDeliveryCertificationAuthority;
    identity: GovernorDeliveryAdapterIdentity;
    now: number;
  }): void {
    this.#write(params, "revoked");
  }

  assertCertified(identity: GovernorDeliveryAdapterIdentity): void {
    const identityKey = governorDeliveryIdentityKey(identity);
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_delivery_certifications")
        .selectAll()
        .where("identity_key", "=", identityKey),
    );
    if (!row) {
      throw new Error("Governor delivery adapter is uncertified");
    }
    const status = row.status === "certified" || row.status === "revoked" ? row.status : "revoked";
    const authority = GovernorHostDeliveryCertificationAuthority.fromEnvironment();
    if (!authority.verifies(identityKey, status, row.certification_signature)) {
      throw new Error("Governor delivery adapter certification signature is invalid");
    }
    if (status !== "certified" || row.revoked_at !== null) {
      throw new Error("Governor delivery adapter is revoked");
    }
  }

  #write(
    params: {
      authority: GovernorHostDeliveryCertificationAuthority;
      identity: GovernorDeliveryAdapterIdentity;
      now: number;
    },
    status: "certified" | "revoked",
  ): void {
    const identityKey = governorDeliveryIdentityKey(params.identity);
    runOpenClawStateWriteTransaction(({ db }) => {
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_delivery_certifications")
          .select(["revoked_at"])
          .where("identity_key", "=", identityKey),
      );
      if (status === "certified" && existing && existing.revoked_at !== null) {
        throw new Error("Governor delivery adapter revocation is final for this identity");
      }
      const row: CertificationRow = {
        identity_key: identityKey,
        status,
        certification_signature: params.authority.sign(identityKey, status),
        created_at: params.now,
        revoked_at: status === "revoked" ? params.now : null,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_delivery_certifications")
          .values(bind(row))
          .onConflict((conflict) => conflict.column("identity_key").doUpdateSet(bind(row))),
      );
    }, this.#options);
  }
}
