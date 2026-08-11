// Reconciles replayable memory rows against the host-owned monotonic generation ledger.
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  isTrustedGovernorMemoryAuthority,
  type GovernorMemoryAuthorityBinding,
  type GovernorMemoryAuthorityState,
  type GovernorTrustedMemoryAuthority,
} from "../../security/governor-host-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest } from "./canonical-json.js";
import { bindGovernorMemory, parseGovernorMemory } from "./memory-record-codec.js";
import type { GovernorMemoryRecord } from "./memory-types.js";

type MemoryAuthorityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_memory_reobservations"
>;
type ReobservationRow = Selectable<OpenClawStateKyselyDatabase["governor_memory_reobservations"]>;

export type GovernorMemoryReobservation = Readonly<{
  requirementId: string;
  scopeKey: string;
  factKey: string;
  authorityGeneration: number;
  authorityBindingDigest: string;
  staleMemoryId: string;
  status: "required" | "resolved";
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<MemoryAuthorityDatabase>(db);

export function governorMemoryAuthorityBinding(
  memory: GovernorMemoryRecord,
): GovernorMemoryAuthorityBinding {
  if (
    memory.status !== "verified" ||
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest
  ) {
    throw new Error("Governor memory authority requires verified evidence bindings");
  }
  return {
    scopeKey: memory.scopeKey,
    factKey: memory.factKey,
    memoryId: memory.memoryId,
    evidenceDigest: memory.verifiedEvidenceDigest,
    semanticDigest: memory.verifiedEvidenceSemanticDigest,
  };
}

function parseRequirement(row: ReobservationRow): GovernorMemoryReobservation {
  return {
    requirementId: row.requirement_id,
    scopeKey: row.scope_key,
    factKey: row.fact_key,
    authorityGeneration: normalizeSqliteNumber(row.authority_generation) ?? 0,
    authorityBindingDigest: row.authority_binding_digest,
    staleMemoryId: row.stale_memory_id,
    status: row.status as "required" | "resolved",
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(row.resolved_at == null ? {} : { resolvedAt: normalizeSqliteNumber(row.resolved_at) ?? 0 }),
  };
}

export class GovernorMemoryAuthorityStore {
  readonly #authority: GovernorTrustedMemoryAuthority;
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: {
    authority: GovernorTrustedMemoryAuthority;
    options: OpenClawStateDatabaseOptions;
  }) {
    if (!isTrustedGovernorMemoryAuthority(params.authority)) {
      throw new Error("Governor memory requires its trusted host generation authority");
    }
    this.#authority = params.authority;
    this.#options = params.options;
  }

  protect(memory: GovernorMemoryRecord): GovernorMemoryRecord {
    const state = this.#authority.advance(governorMemoryAuthorityBinding(memory));
    return {
      ...memory,
      authorityGeneration: state.generation,
      authorityBindingDigest: state.bindingDigest,
    };
  }

  retire(memory: GovernorMemoryRecord): GovernorMemoryAuthorityState {
    return this.#authority.retire(governorMemoryAuthorityBinding(memory));
  }

  state(memory: GovernorMemoryRecord): "current" | "legacy" | "stale" {
    const state = this.#authority.state(memory.scopeKey, memory.factKey);
    if (!state) {
      return "legacy";
    }
    if (
      state.status === "current" &&
      memory.authorityGeneration === state.generation &&
      memory.authorityBindingDigest === state.bindingDigest &&
      this.#authority.matches(
        governorMemoryAuthorityBinding(memory),
        state.generation,
        state.bindingDigest,
      )
    ) {
      return "current";
    }
    return "stale";
  }

  quarantineMismatch(
    db: DatabaseSync,
    memory: GovernorMemoryRecord,
    state: GovernorMemoryAuthorityState,
    now: number,
  ): void {
    if (state.status === "retired") {
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set({ status: "tombstoned", tombstoned_at: now, updated_at: now })
          .where("memory_id", "=", memory.memoryId)
          .where("status", "=", "verified"),
      );
      return;
    }
    const requirementId = governorDigest({
      kind: "memory-reobservation",
      scopeKey: memory.scopeKey,
      factKey: memory.factKey,
      authorityGeneration: state.generation,
      authorityBindingDigest: state.bindingDigest,
    });
    executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_memories")
        .set({ status: "quarantined", updated_at: now })
        .where("memory_id", "=", memory.memoryId)
        .where("status", "=", "verified"),
    );
    executeSqliteQuerySync(
      db,
      dbx(db)
        .insertInto("governor_memory_reobservations")
        .values({
          requirement_id: requirementId,
          scope_key: memory.scopeKey,
          fact_key: memory.factKey,
          authority_generation: state.generation,
          authority_binding_digest: state.bindingDigest,
          stale_memory_id: memory.memoryId,
          status: "required",
          created_at: now,
          updated_at: now,
          resolved_at: null,
        })
        .onConflict((conflict) => conflict.column("requirement_id").doNothing()),
    );
  }

  reconcile(
    db: DatabaseSync,
    verify: (memory: GovernorMemoryRecord) => GovernorMemoryRecord,
    now: number,
  ): void {
    const rows = executeSqliteQuerySync(
      db,
      dbx(db).selectFrom("governor_memories").selectAll().where("status", "=", "verified"),
    ).rows;
    for (const row of rows) {
      const memory = verify(parseGovernorMemory(row));
      const authorityState = this.#authority.state(memory.scopeKey, memory.factKey);
      if (!authorityState) {
        const protectedMemory = this.protect(memory);
        executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_memories")
            .set(bindGovernorMemory(protectedMemory))
            .where("memory_id", "=", memory.memoryId)
            .where("status", "=", "verified"),
        );
        continue;
      }
      if (this.state(memory) === "stale") {
        this.quarantineMismatch(db, memory, authorityState, now);
      }
    }
  }

  resolveRequirements(db: DatabaseSync, memory: GovernorMemoryRecord, now: number): void {
    executeSqliteQuerySync(
      db,
      dbx(db)
        .updateTable("governor_memory_reobservations")
        .set({ status: "resolved", updated_at: now, resolved_at: now })
        .where("scope_key", "=", memory.scopeKey)
        .where("fact_key", "=", memory.factKey)
        .where("status", "=", "required"),
    );
  }

  list(scopeKey: string): GovernorMemoryReobservation[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_memory_reobservations")
        .selectAll()
        .where("scope_key", "=", scopeKey)
        .orderBy("created_at", "asc")
        .orderBy("requirement_id", "asc"),
    ).rows.map(parseRequirement);
  }
}
