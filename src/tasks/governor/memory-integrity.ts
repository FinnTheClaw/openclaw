// Enforces exact-scope memory ACLs, provenance, epochs, quarantine, and transactional tombstones.
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
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
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { loadCurrentGovernorEvidenceInTransaction } from "./current-evidence.js";
import { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import { bindGovernorMemory, parseGovernorMemory } from "./memory-record-codec.js";
import {
  GOVERNOR_MEMORY_SOURCE_RANK,
  normalizeGovernorFactKey,
  type GovernorForgetResult,
  type GovernorMemoryRecord,
  type GovernorMemorySourceKind,
  type GovernorMemoryWriteResult,
} from "./memory-types.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import {
  isGovernorEvidenceAdmissionStore,
  type GovernorEvidenceAdmissionStore,
} from "./store-evidence-admission.js";
import type { GovernorStoreQueries } from "./store-queries.js";
import {
  canonicalGovernorScopeKey,
  opaqueGovernorReference,
  type GovernorIdentityContext,
  type GovernorTaskId,
  type GovernorTaskScope,
} from "./types.js";

type GovernorMemoryDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_scope_epochs"
>;
type GovernorScopeEpochRow = Selectable<OpenClawStateKyselyDatabase["governor_scope_epochs"]>;

export {
  GOVERNOR_MEMORY_SOURCE_RANK,
  type GovernorForgetResult,
  type GovernorMemoryProvenance,
  type GovernorMemoryRecord,
  type GovernorMemorySourceKind,
  type GovernorMemoryStatus,
  type GovernorMemoryWriteResult,
} from "./memory-types.js";

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<GovernorMemoryDatabase>(db);
}

function assertExactMemoryInput(value: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new Error(`Governor memory input contains unknown field: ${unexpected}`);
  }
}

function parseEpoch(row: GovernorScopeEpochRow | undefined): number {
  return row ? (normalizeSqliteNumber(row.epoch) ?? 0) : 0;
}

export class GovernorMemoryStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #identity: GovernorIdentityContext;
  readonly #admissions: GovernorEvidenceAdmissionStore;
  readonly #authority: GovernorMemoryAuthorityStore;

  constructor(params: {
    stateDir?: string;
    options?: OpenClawStateDatabaseOptions;
    identity: GovernorIdentityContext;
    evidenceAdmissions: GovernorEvidenceAdmissionStore;
    queries: GovernorStoreQueries;
    memoryAuthority: import("../../security/governor-host-readonly.js").GovernorTrustedMemoryAuthority;
  }) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    this.#identity = params.identity;
    if (!isGovernorEvidenceAdmissionStore(params.evidenceAdmissions)) {
      throw new Error("Governor memory store requires its evidence admission owner");
    }
    this.#admissions = params.evidenceAdmissions;
    this.#authority = new GovernorMemoryAuthorityStore({
      authority: params.memoryAuthority,
      options: this.#options,
    });
    initializeGovernorStateSchema(this.#options);
  }

  #database() {
    return openOpenClawStateDatabase(this.#options);
  }

  #epoch(db: DatabaseSync, scopeKey: string): number {
    return parseEpoch(
      executeSqliteQueryTakeFirstSync(
        db,
        dbx(db).selectFrom("governor_scope_epochs").selectAll().where("scope_key", "=", scopeKey),
      ),
    );
  }

  getScopeEpoch(scope: GovernorTaskScope): number {
    return this.#epoch(this.#database().db, canonicalGovernorScopeKey(scope, this.#identity));
  }

  storeCandidate(params: {
    memoryId: string;
    factKey: string;
    scope: GovernorTaskScope;
    expectedScopeEpoch: number;
    content: GovernorJsonValue;
    now: number;
  }): GovernorMemoryWriteResult {
    assertGovernorPersistedJson("memory", params);
    assertExactMemoryInput(params, [
      "memoryId",
      "factKey",
      "scope",
      "expectedScopeEpoch",
      "content",
      "now",
    ]);
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const factKey = normalizeGovernorFactKey(params.factKey);
    const content = assertGovernorBoundarySafe("memory", params.content);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const currentEpoch = this.#epoch(db, scopeKey);
      if (currentEpoch !== params.expectedScopeEpoch) {
        return { stored: false, reason: "scope_epoch_conflict", currentEpoch };
      }
      const memory: GovernorMemoryRecord = {
        memoryId: params.memoryId,
        scopeKey,
        scopeEpoch: currentEpoch,
        factKey,
        status: "candidate",
        sourceKind: "untrusted_candidate",
        sourceIdentity: opaqueGovernorReference(
          "memory-candidate",
          params.memoryId,
          this.#identity,
        ),
        sourceRank: GOVERNOR_MEMORY_SOURCE_RANK.untrusted_candidate,
        observedAt: params.now,
        confidence: 0,
        sensitivity: "normal",
        provenance: {
          sourceRef: opaqueGovernorReference(
            "memory-candidate-ref",
            params.memoryId,
            this.#identity,
          ),
          observedAt: params.now,
          recordedAt: params.now,
          scopeKey,
          confidence: 0,
          sensitivity: "normal",
        },
        content,
        contentDigest: governorDigest(content),
        createdAt: params.now,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_memories").values(bindGovernorMemory(memory)),
      );
      return { stored: true, memory };
    }, this.#options);
  }

  promoteVerified(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    memoryId: string;
    factKey: string;
    scope: GovernorTaskScope;
    expectedScopeEpoch: number;
    freshnessExpiresAt?: number;
    now: number;
  }): GovernorMemoryWriteResult {
    assertGovernorPersistedJson("memory", params);
    assertExactMemoryInput(params, [
      "taskId",
      "evidenceId",
      "memoryId",
      "factKey",
      "scope",
      "expectedScopeEpoch",
      "freshnessExpiresAt",
      "now",
    ]);
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const factKey = normalizeGovernorFactKey(params.factKey);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const evidence = loadCurrentGovernorEvidenceInTransaction({
        db,
        admissions: this.#admissions,
        taskId: params.taskId,
        evidenceId: params.evidenceId,
      });
      if (
        evidence.scopeKey !== scopeKey ||
        evidence.predicate !== governorMemoryFactPredicate(factKey) ||
        governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
          evidence.semanticDigest ||
        governorDigest(evidence.payload) !== evidence.evidenceDigest ||
        governorDigest(evidence.payload) !== governorDigest(evidence.value) ||
        evidence.invalidatedAt !== undefined
      ) {
        throw new Error("Governor verified memory evidence does not match the fact and scope");
      }
      const sourceKind = evidence.sourceKind as GovernorMemorySourceKind;
      const sourceRank = GOVERNOR_MEMORY_SOURCE_RANK[sourceKind] ?? 0;
      if (sourceRank <= 0 || sourceKind === "historical_memory") {
        throw new Error("Governor verified memory evidence source is not authoritative");
      }
      const content = assertGovernorBoundarySafe("memory", evidence.value);
      const confidence =
        sourceKind === "structured_external" ? 1 : sourceKind === "authenticated_user" ? 0.95 : 0.9;
      const currentEpoch = this.#epoch(db, scopeKey);
      if (currentEpoch !== params.expectedScopeEpoch) {
        return { stored: false, reason: "scope_epoch_conflict", currentEpoch };
      }
      const activeFact = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .select(["memory_id"])
          .where("scope_key", "=", scopeKey)
          .where("fact_key", "=", factKey)
          .where("status", "=", "verified"),
      );
      if (activeFact && activeFact.memory_id !== params.memoryId) {
        return { stored: false, reason: "fact_version_conflict", currentEpoch };
      }
      const protectedMemory = this.#authority.protect({
        memoryId: params.memoryId,
        scopeKey,
        scopeEpoch: currentEpoch,
        factKey,
        status: "verified",
        sourceKind,
        sourceIdentity: evidence.sourceIdentity,
        sourceRank,
        observedAt: evidence.observedAt,
        ...(params.freshnessExpiresAt === undefined
          ? {}
          : { freshnessExpiresAt: params.freshnessExpiresAt }),
        confidence,
        sensitivity: "normal",
        provenance: {
          sourceRef: evidence.sourceIdentity,
          observedAt: evidence.observedAt,
          recordedAt: params.now,
          scopeKey,
          confidence,
          sensitivity: "normal",
          evidenceTaskId: evidence.taskId,
          evidenceTaskVersion: evidence.taskVersion,
          objectiveRevision: evidence.objectiveRevision,
          planVersion: evidence.planVersion,
        },
        content,
        contentDigest: governorDigest(content),
        verifiedEvidenceTaskId: evidence.taskId,
        verifiedEvidenceId: evidence.evidenceId,
        verifiedEvidenceDigest: evidence.evidenceDigest,
        verifiedEvidenceSemanticDigest: evidence.semanticDigest,
        createdAt: params.now,
        updatedAt: params.now,
      });
      if (!protectedMemory.accepted) {
        return { stored: false, reason: "provenance_rejected", currentEpoch };
      }
      const memory = protectedMemory.memory;
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_memories").values(bindGovernorMemory(memory)),
      );
      this.#authority.resolveRequirements(db, memory, params.now);
      return { stored: true, memory };
    }, this.#options);
  }

  #verifyRecalledMemory(db: DatabaseSync, memory: GovernorMemoryRecord): GovernorMemoryRecord {
    if (memory.status !== "verified") {
      return memory;
    }
    if (
      !memory.verifiedEvidenceTaskId ||
      !memory.verifiedEvidenceId ||
      !memory.verifiedEvidenceDigest ||
      !memory.verifiedEvidenceSemanticDigest ||
      memory.provenance.evidenceTaskId !== memory.verifiedEvidenceTaskId ||
      memory.provenance.evidenceTaskVersion === undefined ||
      memory.provenance.objectiveRevision === undefined ||
      memory.provenance.planVersion === undefined ||
      memory.provenance.recordedAt === undefined
    ) {
      throw new Error(`Governor verified memory ${memory.memoryId} lacks admitted evidence`);
    }
    const evidence = loadCurrentGovernorEvidenceInTransaction({
      db,
      admissions: this.#admissions,
      taskId: memory.verifiedEvidenceTaskId as import("./types.js").GovernorTaskId,
      evidenceId: memory.verifiedEvidenceId,
    });
    if (
      evidence.invalidatedAt !== undefined ||
      evidence.scopeKey !== memory.scopeKey ||
      evidence.evidenceDigest !== memory.verifiedEvidenceDigest ||
      evidence.semanticDigest !== memory.verifiedEvidenceSemanticDigest ||
      evidence.sourceIdentity !== memory.sourceIdentity ||
      evidence.sourceIdentity !== memory.provenance.sourceRef ||
      evidence.taskId !== memory.provenance.evidenceTaskId ||
      evidence.taskVersion !== memory.provenance.evidenceTaskVersion ||
      evidence.objectiveRevision !== memory.provenance.objectiveRevision ||
      evidence.planVersion !== memory.provenance.planVersion ||
      evidence.predicate !== governorMemoryFactPredicate(memory.factKey) ||
      governorDigest(evidence.value) !== memory.contentDigest
    ) {
      throw new Error(`Governor verified memory ${memory.memoryId} evidence binding is invalid`);
    }
    return memory;
  }

  retrieve(params: { scope: GovernorTaskScope; now: number }): GovernorMemoryRecord[] {
    assertGovernorPersistedJson("memory", params);
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    return runOpenClawStateWriteTransaction(({ db }) => {
      this.#authority.reconcile(db, (memory) => this.#verifyRecalledMemory(db, memory), params.now);
      return executeSqliteQuerySync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .selectAll()
          .where("scope_key", "=", scopeKey)
          .where("status", "in", ["candidate", "verified"])
          .where((eb) =>
            eb.or([
              eb("freshness_expires_at", "is", null),
              eb("freshness_expires_at", ">", params.now),
            ]),
          )
          .orderBy("source_rank", "desc")
          .orderBy("observed_at", "desc")
          .orderBy("memory_id", "asc"),
      ).rows.map(parseGovernorMemory);
    }, this.#options);
  }

  retrieveAudit(params: { scope: GovernorTaskScope }): GovernorMemoryRecord[] {
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const { db } = this.#database();
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_memories")
        .selectAll()
        .where("scope_key", "=", scopeKey)
        .orderBy("created_at", "asc")
        .orderBy("memory_id", "asc"),
    ).rows.map(parseGovernorMemory);
  }

  quarantine(params: {
    memoryId: string;
    scope: GovernorTaskScope;
    now: number;
  }): GovernorMemoryRecord | null {
    assertGovernorPersistedJson("memory", params);
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .selectAll()
          .where("memory_id", "=", params.memoryId)
          .where("scope_key", "=", scopeKey),
      );
      if (!row) {
        return null;
      }
      const memory = {
        ...parseGovernorMemory(row),
        status: "quarantined" as const,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set(bindGovernorMemory(memory))
          .where("memory_id", "=", params.memoryId)
          .where("scope_key", "=", scopeKey),
      );
      return memory;
    }, this.#options);
  }

  forget(params: {
    memoryId: string;
    scope: GovernorTaskScope;
    expectedScopeEpoch: number;
    now: number;
  }): GovernorForgetResult {
    assertGovernorPersistedJson("memory", params);
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const currentEpoch = this.#epoch(db, scopeKey);
      if (currentEpoch !== params.expectedScopeEpoch) {
        return {
          status: "partial_failure",
          memoryId: params.memoryId,
          scopeEpoch: currentEpoch,
          failed: ["scope_epoch_conflict"],
        };
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .selectAll()
          .where("memory_id", "=", params.memoryId)
          .where("scope_key", "=", scopeKey)
          .where("status", "!=", "tombstoned"),
      );
      if (!row) {
        return { status: "not_found", memoryId: params.memoryId, scopeEpoch: currentEpoch };
      }
      const nextEpoch = currentEpoch + 1;
      const currentMemory = parseGovernorMemory(row);
      if (currentMemory.status === "verified") {
        const authorityState = this.#authority.state(currentMemory);
        if (authorityState === "current" || authorityState === "legacy") {
          this.#authority.retire(currentMemory);
        }
      }
      const memory: GovernorMemoryRecord = {
        ...currentMemory,
        status: "tombstoned",
        updatedAt: params.now,
        tombstonedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set(bindGovernorMemory(memory))
          .where("memory_id", "=", params.memoryId)
          .where("scope_key", "=", scopeKey),
      );
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_scope_epochs")
          .values({ scope_key: scopeKey, epoch: nextEpoch, updated_at: params.now })
          .onConflict((conflict) =>
            conflict.column("scope_key").doUpdateSet({
              epoch: nextEpoch,
              updated_at: params.now,
            }),
          ),
      );
      return {
        status: "deleted",
        memoryId: params.memoryId,
        scopeEpoch: nextEpoch,
        invalidated: ["primary", "scope_epoch"],
      };
    }, this.#options);
  }

  listReobservationRequirements(scope: GovernorTaskScope) {
    return this.#authority.list(canonicalGovernorScopeKey(scope, this.#identity));
  }
}
