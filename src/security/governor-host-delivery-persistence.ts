/** Host-only delivery certification, revocation, and effect-boundary fencing. */
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
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type {
  GovernorHostAntiRollbackLedger,
  GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";
import type { GovernorDeliveryManualResolution } from "./governor-host-contracts.js";

type HostDeliveryDb = Pick<
  StateDb,
  | "governor_delivery_certification_epochs"
  | "governor_delivery_certifications"
  | "governor_delivery_dispatch_claims"
>;
const dbx = (db: DatabaseSync) => getNodeSqliteKysely<HostDeliveryDb>(db);

export type DeliveryCertificationInput = Readonly<{
  handle: string;
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  signature: string;
  observedAt: number;
}>;

export type DeliveryEffectInput = DeliveryCertificationInput &
  Readonly<{
    claimId: string;
    deploymentIdentity: string;
    deliveryKey: string;
    payloadDigest: string;
  }>;

export type DeliveryReviewInput = DeliveryEffectInput &
  Readonly<{
    resolution: GovernorDeliveryManualResolution;
    reasonDigest: string;
    resolutionSignature: string;
  }>;

type DeliveryState = Readonly<{ generation: number; status: "certified" | "revoked" }>;

export type GovernorHostDeliveryPersistence = Readonly<{
  deliveryHighWater: (identityKey: string) => GovernorLedgerState | null;
  certifyDelivery: (input: DeliveryCertificationInput) => GovernorLedgerState;
  deliveryBindingMatches: (
    input: DeliveryCertificationInput & { status: "certified" | "revoked" },
  ) => boolean;
  revokeDelivery: (input: DeliveryCertificationInput) => boolean;
  deliveryState: (identityKey: string) => DeliveryState | null;
  claimDeliveryEffect: (input: DeliveryEffectInput) => boolean;
  startDeliveryEffect: (input: DeliveryEffectInput) => boolean;
  deliveryEffectState: (
    input: DeliveryEffectInput,
  ) => "claimed" | "effect_started" | "completed" | "cancelled" | null;
  completeDeliveryEffect: (claimId: string, completedAt: number) => boolean;
  markDeliveryEffectUnknown: (input: DeliveryEffectInput & { reasonDigest: string }) => boolean;
  resolveDeliveryEffect: (input: DeliveryReviewInput) => boolean;
}>;

function deliveryBinding(
  input: DeliveryCertificationInput & { status: "certified" | "revoked" },
): string {
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

function primaryBindingMatches(
  db: DatabaseSync,
  input: DeliveryCertificationInput,
  status: "certified" | "revoked",
): boolean {
  const epoch = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_delivery_certification_epochs")
      .select("generation")
      .where("identity_key", "=", input.identityKey),
  );
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_delivery_certifications")
      .selectAll()
      .where("identity_key", "=", input.identityKey),
  );
  return Boolean(
    row &&
    row.status === status &&
    row.implementation_digest === input.implementationDigest &&
    row.config_digest === input.configDigest &&
    normalizeSqliteNumber(row.certification_generation) === input.generation &&
    normalizeSqliteNumber(epoch?.generation ?? null) === input.generation &&
    row.authority_key_id === "host-broker-v1" &&
    normalizeSqliteNumber(row.authority_version) === 1 &&
    row.certification_signature === input.signature,
  );
}

function writePrimaryCertification(
  db: DatabaseSync,
  input: DeliveryCertificationInput,
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

function hasStartedEffect(db: DatabaseSync, identityKey: string): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_delivery_dispatch_claims")
        .select("claim_id")
        .where("identity_key", "=", identityKey)
        .where("state", "=", "effect_started")
        .limit(1),
    ),
  );
}

function claimMatches(
  row: StateDb["governor_delivery_dispatch_claims"],
  input: DeliveryEffectInput,
): boolean {
  return (
    row.identity_key === input.identityKey &&
    row.handle === input.handle &&
    row.implementation_digest === input.implementationDigest &&
    row.config_digest === input.configDigest &&
    normalizeSqliteNumber(row.certification_generation) === input.generation &&
    row.deployment_ref === input.deploymentIdentity &&
    row.delivery_key === input.deliveryKey &&
    row.payload_digest === input.payloadDigest
  );
}

export function createGovernorHostDeliveryPersistence(params: {
  options: OpenClawStateDatabaseOptions;
  ledger: GovernorHostAntiRollbackLedger;
  testAfterLedgerAppend?: () => void;
}): GovernorHostDeliveryPersistence {
  const { options, ledger } = params;
  return Object.freeze({
    deliveryHighWater: (identityKey) => ledger.state("delivery", identityKey),
    certifyDelivery: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const current = ledger.state("delivery", input.identityKey);
        const bindingDigest = deliveryBinding({ ...input, status: "certified" });
        if (hasStartedEffect(db, input.identityKey)) {
          // Restart reconstruction is allowed only for the byte-identical
          // certified binding. It exposes reconciliation but never resets or
          // resends an effect_started delivery.
          if (
            current?.generation === input.generation &&
            current.status === "certified" &&
            current.bindingDigest === bindingDigest &&
            primaryBindingMatches(db, input, "certified")
          ) {
            return current;
          }
          throw new Error("Governor delivery certification is blocked by an in-flight effect");
        }
        if (
          current &&
          (input.generation < current.generation ||
            (input.generation === current.generation &&
              (current.status !== "certified" || current.bindingDigest !== bindingDigest)))
        ) {
          throw new Error("Governor delivery identity generation is durably stale");
        }
        const next = ledger.append({
          kind: "delivery",
          key: input.identityKey,
          generation: input.generation,
          status: "certified",
          bindingDigest,
        });
        writePrimaryCertification(db, input, "certified");
        return next;
      }, options),
    deliveryBindingMatches: (input) => {
      const state = ledger.state("delivery", input.identityKey);
      return (
        state?.generation === input.generation &&
        state.status === input.status &&
        state.bindingDigest === deliveryBinding(input)
      );
    },
    revokeDelivery: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        if (hasStartedEffect(db, input.identityKey)) {
          return false;
        }
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
        executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_delivery_dispatch_claims")
            .set({ state: "cancelled", completed_at: input.observedAt })
            .where("identity_key", "=", input.identityKey)
            .where("state", "=", "claimed"),
        );
        writePrimaryCertification(db, input, "revoked");
        return true;
      }, options),
    deliveryState: (identityKey) => {
      const state = ledger.state("delivery", identityKey);
      return state && (state.status === "certified" || state.status === "revoked")
        ? { generation: state.generation, status: state.status }
        : null;
    },
    claimDeliveryEffect: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const state = ledger.state("delivery", input.identityKey);
        if (
          state?.generation !== input.generation ||
          state.status !== "certified" ||
          state.bindingDigest !== deliveryBinding({ ...input, status: "certified" }) ||
          !primaryBindingMatches(db, input, "certified")
        ) {
          return false;
        }
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_dispatch_claims")
            .selectAll()
            .where("delivery_key", "=", input.deliveryKey),
        );
        if (existing) {
          return (
            existing.claim_id === input.claimId &&
            claimMatches(existing, input) &&
            existing.state === "claimed"
          );
        }
        const insert = executeSqliteQuerySync(
          db,
          dbx(db).insertInto("governor_delivery_dispatch_claims").values({
            claim_id: input.claimId,
            identity_key: input.identityKey,
            handle: input.handle,
            implementation_digest: input.implementationDigest,
            config_digest: input.configDigest,
            certification_generation: input.generation,
            deployment_ref: input.deploymentIdentity,
            delivery_key: input.deliveryKey,
            payload_digest: input.payloadDigest,
            state: "claimed",
            claimed_at: input.observedAt,
            effect_started_at: null,
            completed_at: null,
            review_state: null,
            review_reason_digest: null,
            review_resolution_signature: null,
            review_key_id: null,
            review_key_version: null,
            review_updated_at: null,
          }),
        );
        return insert.numAffectedRows === 1n;
      }, options),
    startDeliveryEffect: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_dispatch_claims")
            .selectAll()
            .where("claim_id", "=", input.claimId),
        );
        const state = ledger.state("delivery", input.identityKey);
        if (
          !row ||
          row.state !== "claimed" ||
          !claimMatches(row, input) ||
          state?.generation !== input.generation ||
          state.status !== "certified" ||
          !primaryBindingMatches(db, input, "certified")
        ) {
          return false;
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_delivery_dispatch_claims")
            .set({ state: "effect_started", effect_started_at: input.observedAt })
            .where("claim_id", "=", input.claimId)
            .where("state", "=", "claimed"),
        );
        return update.numAffectedRows === 1n;
      }, options),
    deliveryEffectState: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_dispatch_claims")
            .selectAll()
            .where("claim_id", "=", input.claimId),
        );
        return row && claimMatches(row, input)
          ? (row.state as "claimed" | "effect_started" | "completed" | "cancelled")
          : null;
      }, options),
    completeDeliveryEffect: (claimId, completedAt) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_delivery_dispatch_claims")
            .set({ state: "completed", completed_at: completedAt })
            .where("claim_id", "=", claimId)
            .where("state", "=", "effect_started"),
        );
        return update.numAffectedRows === 1n;
      }, options),
    markDeliveryEffectUnknown: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_dispatch_claims")
            .selectAll()
            .where("claim_id", "=", input.claimId),
        );
        if (!row || row.state !== "effect_started" || !claimMatches(row, input)) {
          return false;
        }
        if (row.review_state === "pending") {
          return row.review_reason_digest === input.reasonDigest;
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_delivery_dispatch_claims")
            .set({
              review_state: "pending",
              review_reason_digest: input.reasonDigest,
              review_updated_at: input.observedAt,
            })
            .where("claim_id", "=", input.claimId)
            .where("state", "=", "effect_started")
            .where("review_state", "is", null),
        );
        return update.numAffectedRows === 1n;
      }, options),
    resolveDeliveryEffect: (input) =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_delivery_dispatch_claims")
            .selectAll()
            .where("claim_id", "=", input.claimId),
        );
        if (!row || !claimMatches(row, input)) {
          return false;
        }
        if (row.review_state === input.resolution) {
          return (
            row.review_reason_digest === input.reasonDigest &&
            row.review_key_id === "host-broker-v1" &&
            normalizeSqliteNumber(row.review_key_version) === 1 &&
            Boolean(row.review_resolution_signature)
          );
        }
        const state = ledger.state("delivery", input.identityKey);
        if (
          row.state !== "effect_started" ||
          row.review_state !== "pending" ||
          state?.generation !== input.generation ||
          state.status !== "certified" ||
          !primaryBindingMatches(db, input, "certified")
        ) {
          return false;
        }
        const update = executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_delivery_dispatch_claims")
            .set({
              state: input.resolution === "confirmed_sent" ? "completed" : "cancelled",
              completed_at: input.observedAt,
              review_state: input.resolution,
              review_reason_digest: input.reasonDigest,
              review_resolution_signature: input.resolutionSignature,
              review_key_id: "host-broker-v1",
              review_key_version: 1,
              review_updated_at: input.observedAt,
            })
            .where("claim_id", "=", input.claimId)
            .where("state", "=", "effect_started")
            .where("review_state", "=", "pending"),
        );
        return update.numAffectedRows === 1n;
      }, options),
  });
}
