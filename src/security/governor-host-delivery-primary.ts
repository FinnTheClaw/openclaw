import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as StateDb } from "../state/openclaw-state-db.generated.js";

type HostDeliveryDb = Pick<
  StateDb,
  | "governor_delivery_certification_epochs"
  | "governor_delivery_certifications"
  | "governor_delivery_dispatch_claims"
>;

type DeliveryCertificationBinding = Readonly<{
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  signature: string;
  observedAt: number;
}>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<HostDeliveryDb>(db);

export function writePrimaryDeliveryCertification(
  db: DatabaseSync,
  input: DeliveryCertificationBinding,
  status: "certified" | "revoked",
): void {
  executeSqliteQuerySync(
    db,
    dbx(db)
      .insertInto("governor_delivery_certification_epochs")
      .values({
        identity_key: input.identityKey,
        generation: input.generation,
        updated_at: input.observedAt,
      })
      .onConflict((conflict) =>
        conflict.column("identity_key").doUpdateSet({
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
        status,
        implementation_digest: input.implementationDigest,
        config_digest: input.configDigest,
        certification_generation: input.generation,
        authority_key_id: "host-broker-v1",
        authority_version: 1,
        certification_signature: input.signature,
        created_at: input.observedAt,
        revoked_at: status === "revoked" ? input.observedAt : null,
      })
      .onConflict((conflict) =>
        conflict.column("identity_key").doUpdateSet({
          status,
          implementation_digest: input.implementationDigest,
          config_digest: input.configDigest,
          certification_generation: input.generation,
          authority_key_id: "host-broker-v1",
          authority_version: 1,
          certification_signature: input.signature,
          revoked_at: status === "revoked" ? input.observedAt : null,
        }),
      ),
  );
}
