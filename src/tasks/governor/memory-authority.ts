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
import { assertGovernorPersistedJson } from "./persistence-guard.js";

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

export type GovernorMemoryProtection =
  | Readonly<{ accepted: true; memory: GovernorMemoryRecord }>
  | Readonly<{
      accepted: false;
      reason: "legacy_high_water" | "retired" | "stale" | "weaker" | "fence_regression";
      state: GovernorMemoryAuthorityState;
    }>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<MemoryAuthorityDatabase>(db);

export function governorMemoryAuthorityBinding(
  memory: GovernorMemoryRecord,
): GovernorMemoryAuthorityBinding {
  if (
    memory.status !== "verified" ||
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest ||
    !memory.verifiedEvidenceTaskId ||
    memory.provenance.evidenceTaskId !== memory.verifiedEvidenceTaskId ||
    memory.provenance.evidenceTaskVersion === undefined ||
    memory.provenance.objectiveRevision === undefined ||
    memory.provenance.planVersion === undefined ||
    memory.provenance.recordedAt === undefined
  ) {
    throw new Error("Governor memory authority requires verified evidence bindings");
  }
  return {
    scopeKey: memory.scopeKey,
    factKey: memory.factKey,
    scopeEpoch: memory.scopeEpoch,
    memoryId: memory.memoryId,
    sourceIdentity: memory.sourceIdentity,
    sourceReference: memory.provenance.sourceRef,
    contentDigest: memory.contentDigest,
    evidenceDigest: memory.verifiedEvidenceDigest,
    semanticDigest: memory.verifiedEvidenceSemanticDigest,
    ordering: {
      scopeEpoch: memory.scopeEpoch,
      observedAt: memory.observedAt,
      recordedAt: memory.provenance.recordedAt,
      sourceRank: memory.sourceRank,
      confidenceMillionths: Math.round(memory.confidence * 1_000_000),
      taskVersion: memory.provenance.evidenceTaskVersion,
      objectiveRevision: memory.provenance.objectiveRevision,
      planVersion: memory.provenance.planVersion,
      taskDigest: governorDigest({ taskId: memory.verifiedEvidenceTaskId }),
    },
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

  protect(memory: GovernorMemoryRecord): GovernorMemoryProtection {
    assertGovernorPersistedJson("memory", memory);
    const decision = this.#authority.advance(governorMemoryAuthorityBinding(memory));
    if (!decision.accepted) {
      return decision;
    }
    return {
      accepted: true,
      memory: {
        ...memory,
        authorityGeneration: decision.state.generation,
        authorityBindingDigest: decision.state.bindingDigest,
      },
    };
  }

  retire(memory: GovernorMemoryRecord): GovernorMemoryAuthorityState {
    assertGovernorPersistedJson("memory", memory);
    return this.#authority.retire(governorMemoryAuthorityBinding(memory));
  }

  state(memory: GovernorMemoryRecord): "current" | "legacy" | "stale" {
    assertGovernorPersistedJson("memory", memory);
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
    assertGovernorPersistedJson("memory", { memory, state, now });
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

  quarantineUnverifiable(db: DatabaseSync, memory: GovernorMemoryRecord, now: number): void {
    assertGovernorPersistedJson("memory", { memory, now });
    const state = this.#authority.state(memory.scopeKey, memory.factKey);
    this.quarantineMismatch(
      db,
      memory,
      state ?? {
        generation: 0,
        status: "current",
        bindingDigest: governorDigest({
          kind: "memory-unverifiable",
          scopeKey: memory.scopeKey,
          factKey: memory.factKey,
        }),
        ledgerDigest: governorDigest({ kind: "memory-authority-missing" }),
      },
      now,
    );
  }

  reconcile(
    db: DatabaseSync,
    verify: (memory: GovernorMemoryRecord) => GovernorMemoryRecord,
    now: number,
  ): void {
    assertGovernorPersistedJson("memory", { now });
    const rows = executeSqliteQuerySync(
      db,
      dbx(db).selectFrom("governor_memories").selectAll().where("status", "=", "verified"),
    ).rows;
    for (const row of rows) {
      const parsed = parseGovernorMemory(row);
      let memory: GovernorMemoryRecord;
      try {
        memory = verify(parsed);
      } catch {
        this.quarantineUnverifiable(db, parsed, now);
        continue;
      }
      const authorityState = this.#authority.state(memory.scopeKey, memory.factKey);
      if (!authorityState) {
        const protectedMemory = this.protect(memory);
        if (!protectedMemory.accepted) {
          this.quarantineMismatch(db, memory, protectedMemory.state, now);
          continue;
        }
        executeSqliteQuerySync(
          db,
          dbx(db)
            .updateTable("governor_memories")
            .set(bindGovernorMemory(protectedMemory.memory))
            .where("memory_id", "=", memory.memoryId)
            .where("status", "=", "verified"),
        );
        continue;
      }
      let memoryState: "current" | "legacy" | "stale";
      try {
        memoryState = this.state(memory);
      } catch {
        this.quarantineUnverifiable(db, memory, now);
        continue;
      }
      if (memoryState === "stale") {
        this.quarantineMismatch(db, memory, authorityState, now);
      }
    }
  }

  resolveRequirements(db: DatabaseSync, memory: GovernorMemoryRecord, now: number): void {
    assertGovernorPersistedJson("memory", { memory, now });
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
    assertGovernorPersistedJson("memory", { scopeKey });
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
