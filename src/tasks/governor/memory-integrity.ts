// Enforces exact-scope memory ACLs, provenance, epochs, quarantine, and transactional tombstones.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
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
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import {
  canonicalGovernorScopeKey,
  opaqueGovernorReference,
  type GovernorIdentityContext,
  type GovernorTaskScope,
} from "./types.js";

type GovernorMemoryDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_scope_epochs"
>;
type GovernorMemoryRow = Selectable<OpenClawStateKyselyDatabase["governor_memories"]>;
type GovernorScopeEpochRow = Selectable<OpenClawStateKyselyDatabase["governor_scope_epochs"]>;

export type GovernorMemoryStatus = "candidate" | "verified" | "quarantined" | "tombstoned";
export type GovernorMemorySourceKind =
  | "structured_external"
  | "authenticated_user"
  | "tool"
  | "historical_memory"
  | "assistant_text"
  | "hidden_reasoning";

export type GovernorMemoryProvenance = {
  sourceRef: string;
  observedAt: number;
  scopeKey: string;
  confidence: number;
  sensitivity: "normal" | "sensitive";
};

export type GovernorMemoryRecord = {
  memoryId: string;
  scopeKey: string;
  scopeEpoch: number;
  status: GovernorMemoryStatus;
  sourceKind: GovernorMemorySourceKind;
  sourceIdentity: string;
  sourceRank: number;
  observedAt: number;
  freshnessExpiresAt?: number;
  confidence: number;
  sensitivity: "normal" | "sensitive";
  provenance: GovernorMemoryProvenance;
  content: GovernorJsonValue;
  contentDigest: string;
  supersedesId?: string;
  createdAt: number;
  updatedAt: number;
  tombstonedAt?: number;
};

export type GovernorMemoryWriteResult =
  | { stored: true; memory: GovernorMemoryRecord }
  | { stored: false; reason: "scope_epoch_conflict" | "provenance_rejected"; currentEpoch: number };

export type GovernorForgetResult =
  | {
      status: "deleted";
      memoryId: string;
      scopeEpoch: number;
      invalidated: readonly ["primary", "scope_epoch"];
    }
  | { status: "not_found"; memoryId: string; scopeEpoch: number }
  | { status: "partial_failure"; memoryId: string; scopeEpoch: number; failed: readonly string[] };

const SOURCE_RANK: Record<GovernorMemorySourceKind, number> = {
  structured_external: 600,
  authenticated_user: 500,
  tool: 400,
  historical_memory: 200,
  assistant_text: 0,
  hidden_reasoning: 0,
};

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<GovernorMemoryDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid governor memory ${label}`, { cause: error });
  }
}

function parseMemory(row: GovernorMemoryRow): GovernorMemoryRecord {
  return {
    memoryId: row.memory_id,
    scopeKey: row.scope_key,
    scopeEpoch: normalizeSqliteNumber(row.scope_epoch) ?? 0,
    status: row.status as GovernorMemoryStatus,
    sourceKind: row.source_kind as GovernorMemorySourceKind,
    sourceIdentity: row.source_identity,
    sourceRank: normalizeSqliteNumber(row.source_rank) ?? 0,
    observedAt: normalizeSqliteNumber(row.observed_at) ?? 0,
    ...(row.freshness_expires_at == null
      ? {}
      : { freshnessExpiresAt: normalizeSqliteNumber(row.freshness_expires_at) ?? 0 }),
    confidence: row.confidence,
    sensitivity: row.sensitivity as GovernorMemoryRecord["sensitivity"],
    provenance: parseJson(row.provenance_json, "provenance") as GovernorMemoryProvenance,
    content: parseJson(row.content_json, "content") as GovernorJsonValue,
    contentDigest: row.content_digest,
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(row.tombstoned_at == null
      ? {}
      : { tombstonedAt: normalizeSqliteNumber(row.tombstoned_at) ?? 0 }),
  };
}

function bindMemory(memory: GovernorMemoryRecord): Insertable<GovernorMemoryRow> {
  return {
    memory_id: memory.memoryId,
    scope_key: memory.scopeKey,
    scope_epoch: memory.scopeEpoch,
    status: memory.status,
    source_kind: memory.sourceKind,
    source_identity: memory.sourceIdentity,
    source_rank: memory.sourceRank,
    observed_at: memory.observedAt,
    freshness_expires_at: memory.freshnessExpiresAt ?? null,
    confidence: memory.confidence,
    sensitivity: memory.sensitivity,
    provenance_json: JSON.stringify(memory.provenance),
    content_json: JSON.stringify(memory.content),
    content_digest: memory.contentDigest,
    supersedes_id: memory.supersedesId ?? null,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    tombstoned_at: memory.tombstonedAt ?? null,
  };
}

function parseEpoch(row: GovernorScopeEpochRow | undefined): number {
  return row ? (normalizeSqliteNumber(row.epoch) ?? 0) : 0;
}

function isAdmissiblePromotion(sourceKind: GovernorMemorySourceKind, sourceRef: string): boolean {
  return (
    SOURCE_RANK[sourceKind] > 0 && sourceKind !== "historical_memory" && Boolean(sourceRef.trim())
  );
}

export class GovernorMemoryStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #identity: GovernorIdentityContext;

  constructor(params: {
    stateDir?: string;
    options?: OpenClawStateDatabaseOptions;
    identity: GovernorIdentityContext;
  }) {
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    this.#identity = params.identity;
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

  store(params: {
    memoryId: string;
    scope: GovernorTaskScope;
    expectedScopeEpoch: number;
    requestedStatus: Extract<GovernorMemoryStatus, "candidate" | "verified">;
    sourceKind: GovernorMemorySourceKind;
    sourceIdentity: string;
    observedAt: number;
    freshnessExpiresAt?: number;
    confidence: number;
    sensitivity: GovernorMemoryRecord["sensitivity"];
    sourceRef: string;
    content: GovernorJsonValue;
    supersedesId?: string;
    now: number;
  }): GovernorMemoryWriteResult {
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const content = assertGovernorBoundarySafe("memory", params.content);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const currentEpoch = this.#epoch(db, scopeKey);
      if (currentEpoch !== params.expectedScopeEpoch) {
        return { stored: false, reason: "scope_epoch_conflict", currentEpoch };
      }
      if (
        params.requestedStatus === "verified" &&
        !isAdmissiblePromotion(params.sourceKind, params.sourceRef)
      ) {
        return { stored: false, reason: "provenance_rejected", currentEpoch };
      }
      const status = params.requestedStatus === "verified" ? "verified" : ("candidate" as const);
      const memory: GovernorMemoryRecord = {
        memoryId: params.memoryId,
        scopeKey,
        scopeEpoch: currentEpoch,
        status,
        sourceKind: params.sourceKind,
        sourceIdentity: opaqueGovernorReference(
          "memory-source",
          params.sourceIdentity,
          this.#identity,
        ),
        sourceRank: SOURCE_RANK[params.sourceKind],
        observedAt: params.observedAt,
        ...(params.freshnessExpiresAt !== undefined
          ? { freshnessExpiresAt: params.freshnessExpiresAt }
          : {}),
        confidence: params.confidence,
        sensitivity: params.sensitivity,
        provenance: {
          sourceRef: opaqueGovernorReference("memory-source-ref", params.sourceRef, this.#identity),
          observedAt: params.observedAt,
          scopeKey,
          confidence: params.confidence,
          sensitivity: params.sensitivity,
        },
        content,
        contentDigest: governorDigest(content),
        ...(params.supersedesId ? { supersedesId: params.supersedesId } : {}),
        createdAt: params.now,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_memories").values(bindMemory(memory)),
      );
      return { stored: true, memory };
    }, this.#options);
  }

  retrieve(params: { scope: GovernorTaskScope; now: number }): GovernorMemoryRecord[] {
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const { db } = this.#database();
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
    ).rows.map(parseMemory);
  }

  quarantine(params: {
    memoryId: string;
    scope: GovernorTaskScope;
    now: number;
  }): GovernorMemoryRecord | null {
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
      const memory = { ...parseMemory(row), status: "quarantined" as const, updatedAt: params.now };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set(bindMemory(memory))
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
      const memory: GovernorMemoryRecord = {
        ...parseMemory(row),
        status: "tombstoned",
        updatedAt: params.now,
        tombstonedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set(bindMemory(memory))
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
}
