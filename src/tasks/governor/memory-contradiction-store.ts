// Applies evidence-qualified memory supersession and deduplicated source remediation.
import type { DatabaseSync } from "node:sqlite";
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
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { loadCurrentGovernorEvidenceInTransaction } from "./current-evidence.js";
import { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import {
  createGovernorMemoryEvidencePredicate,
  governorMemoryRepairPredicate,
  normalizeGovernorContradictionClass,
  normalizeGovernorFactKey,
  qualifyGovernorMemoryContradiction,
  type GovernorMemoryContradictionRejectReason,
} from "./memory-contradiction-policy.js";
import {
  governorMemoryConfidence,
  governorMemoryRemediationTaskId,
  governorMemoryRepairEffectId,
  governorMemoryReplacementId,
} from "./memory-contradiction-records.js";
import type { GovernorMemoryRecord, GovernorMemorySourceKind } from "./memory-integrity.js";
import { bindGovernorMemory, parseGovernorMemory } from "./memory-record-codec.js";
import { listGovernorMemoryRemediations } from "./memory-remediation-query.js";
import {
  bindGovernorMemoryRemediation,
  parseGovernorMemoryRemediation,
  type GovernorMemoryRemediation,
} from "./memory-remediation.js";
import {
  assertGovernorMemoryTaskExecutionFenceCurrent,
  assertGovernorMemoryRepairMutationCurrent,
  requeueGovernorMemoryRepair,
  updateGovernorMemoryRepairState,
  type GovernorMemoryRepairFence,
  type GovernorMemoryRepairMutationGuard,
} from "./memory-repair-state-store.js";
import { loadCurrentGovernorMemoryReplacement } from "./memory-replacement-validator.js";
import { loadCurrentGovernorMemoryScopeEpoch } from "./memory-scope-epoch.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import {
  isGovernorEvidenceAdmissionStore,
  type GovernorEvidenceAdmissionStore,
} from "./store-evidence-admission.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorTaskId } from "./types.js";

type ContradictionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_memory_remediations" | "governor_scope_epochs"
>;

export type GovernorMemoryContradictionResolution =
  | {
      kind: "retired" | "duplicate";
      retired: GovernorMemoryRecord;
      replacement: GovernorMemoryRecord;
      remediation: GovernorMemoryRemediation;
    }
  | { kind: "unresolved"; remediation: GovernorMemoryRemediation }
  | {
      kind: "rejected";
      reason: GovernorMemoryContradictionRejectReason | "not_found" | "state_conflict";
    };

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<ContradictionDatabase>(db);
}

export class GovernorMemoryContradictionStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #admissions: GovernorEvidenceAdmissionStore;
  readonly #authority: GovernorMemoryAuthorityStore;
  readonly #tasks: GovernorTaskAuthorityStore;

  constructor(params: {
    options: OpenClawStateDatabaseOptions;
    evidenceAdmissions: GovernorEvidenceAdmissionStore;
    memoryAuthority: import("../../security/governor-host-readonly.js").GovernorTrustedMemoryAuthority;
    taskAuthority: GovernorTaskAuthorityStore;
  }) {
    if (!isGovernorEvidenceAdmissionStore(params.evidenceAdmissions)) {
      throw new Error("Governor memory contradiction store requires its evidence admission owner");
    }
    this.#options = params.options;
    this.#admissions = params.evidenceAdmissions;
    this.#authority = new GovernorMemoryAuthorityStore({
      authority: params.memoryAuthority,
      options: params.options,
    });
    this.#tasks = params.taskAuthority;
  }

  #evidence(db: DatabaseSync, taskId: GovernorTaskId, evidenceId: string) {
    return loadCurrentGovernorEvidenceInTransaction({
      db,
      admissions: this.#admissions,
      taskId,
      evidenceId,
      tasks: this.#tasks,
    });
  }

  #remediation(db: DatabaseSync, fingerprint: string): GovernorMemoryRemediation | null {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_memory_remediations")
        .selectAll()
        .where("contradiction_fingerprint", "=", fingerprint),
    );
    return row ? parseGovernorMemoryRemediation(row) : null;
  }

  #currentReplacement(
    db: DatabaseSync,
    remediation: GovernorMemoryRemediation,
    now: number,
  ): GovernorMemoryRecord | null {
    return loadCurrentGovernorMemoryReplacement({
      db,
      remediation,
      admissions: this.#admissions,
      authority: this.#authority,
      tasks: this.#tasks,
      now,
    });
  }

  resolve(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    staleMemoryId: string;
    contradictionClass: string;
    executionFence: GovernorMemoryRepairFence;
    freshnessExpiresAt?: number;
    now: number;
  }): GovernorMemoryContradictionResolution {
    assertGovernorPersistedJson("memory", params);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const assertCurrentExecution = () =>
        assertGovernorMemoryTaskExecutionFenceCurrent({
          db,
          taskId: params.taskId,
          executionFence: params.executionFence,
          tasks: this.#tasks,
        });
      const evidence = this.#evidence(db, params.taskId, params.evidenceId);
      const staleRow = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .selectAll()
          .where("memory_id", "=", params.staleMemoryId),
      );
      if (!staleRow) {
        return { kind: "rejected", reason: "not_found" };
      }
      const stale = parseGovernorMemory(staleRow);
      const factKey = normalizeGovernorFactKey(stale.factKey);
      const currentEpoch = loadCurrentGovernorMemoryScopeEpoch(db, stale.scopeKey);
      if (stale.scopeEpoch !== currentEpoch) {
        return { kind: "rejected", reason: "state_conflict" };
      }
      const activeFactRows = executeSqliteQuerySync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .select(["memory_id"])
          .where("scope_key", "=", stale.scopeKey)
          .where("fact_key", "=", factKey)
          .where("scope_epoch", "=", currentEpoch)
          .where("status", "=", "verified"),
      ).rows;
      if (
        stale.status === "verified" &&
        (activeFactRows.length !== 1 || activeFactRows[0]?.memory_id !== stale.memoryId)
      ) {
        return { kind: "rejected", reason: "state_conflict" };
      }
      const contradictionClass = normalizeGovernorContradictionClass(params.contradictionClass);
      const predicate = createGovernorMemoryEvidencePredicate({ memory: stale });
      const qualified = qualifyGovernorMemoryContradiction({
        memory: stale,
        evidence,
        predicate,
        contradictionClass,
      });
      if (qualified.kind === "reject") {
        const existing = stale.contradictionFingerprint
          ? this.#remediation(db, stale.contradictionFingerprint)
          : null;
        if (
          qualified.reason === "inactive_memory" &&
          stale.status === "superseded" &&
          existing?.replacementMemoryId
        ) {
          const replacement = this.#currentReplacement(db, existing, params.now);
          if (replacement && existing.evidenceDigest === evidence.evidenceDigest) {
            return {
              kind: "duplicate",
              retired: stale,
              replacement,
              remediation: existing,
            };
          }
        }
        return { kind: "rejected", reason: qualified.reason };
      }
      const existing = this.#remediation(db, qualified.fingerprint);
      if (
        existing &&
        existing.evidenceDigest === evidence.evidenceDigest &&
        existing.evidenceId === evidence.evidenceId
      ) {
        if (!existing.replacementMemoryId) {
          return { kind: "unresolved", remediation: existing };
        }
        const replacement = this.#currentReplacement(db, existing, params.now);
        if (replacement) {
          return {
            kind: "duplicate",
            retired: stale,
            replacement,
            remediation: existing,
          };
        }
      }
      if (existing && evidence.observedAt <= existing.evidenceObservedAt) {
        return {
          kind: "rejected",
          reason:
            evidence.observedAt < existing.evidenceObservedAt
              ? "older_evidence"
              : "replayed_evidence",
        };
      }
      const sourceKind = evidence.sourceKind as GovernorMemorySourceKind;
      if (qualified.kind === "unresolved") {
        const remediation: GovernorMemoryRemediation = {
          contradictionFingerprint: qualified.fingerprint,
          scopeKey: stale.scopeKey,
          factKey,
          contradictionClass,
          canonicalSourceRef: stale.provenance.sourceRef,
          staleMemoryId: stale.memoryId,
          evidenceId: evidence.evidenceId,
          evidenceDigest: evidence.evidenceDigest,
          evidenceObservedAt: evidence.observedAt,
          status: "unresolved",
          taskId: governorMemoryRemediationTaskId(existing, evidence.taskId),
          investigationCount: (existing?.investigationCount ?? 0) + 1,
          createdAt: existing?.createdAt ?? params.now,
          updatedAt: params.now,
        };
        assertCurrentExecution();
        executeSqliteQuerySync(
          db,
          dbx(db)
            .insertInto("governor_memory_remediations")
            .values(bindGovernorMemoryRemediation(remediation))
            .onConflict((conflict) =>
              conflict
                .column("contradiction_fingerprint")
                .doUpdateSet(bindGovernorMemoryRemediation(remediation)),
            ),
        );
        return { kind: "unresolved", remediation };
      }
      const safeContent = assertGovernorBoundarySafe("memory", evidence.value as GovernorJsonValue);
      if (
        params.freshnessExpiresAt !== undefined &&
        params.freshnessExpiresAt <= evidence.observedAt
      ) {
        throw new Error("Governor replacement freshness must be later than its observation");
      }
      const replacementMemoryId = governorMemoryReplacementId({
        scopeKey: stale.scopeKey,
        factKey,
        evidenceDigest: evidence.evidenceDigest,
        semanticDigest: evidence.semanticDigest,
      });
      const confidence = governorMemoryConfidence(sourceKind);
      assertCurrentExecution();
      const protectedReplacement = this.#authority.protect({
        memoryId: replacementMemoryId,
        scopeKey: stale.scopeKey,
        scopeEpoch: currentEpoch,
        factKey,
        status: "verified",
        sourceKind,
        sourceIdentity: evidence.sourceIdentity,
        sourceRank: qualified.evidenceRank,
        observedAt: evidence.observedAt,
        ...(params.freshnessExpiresAt === undefined
          ? {}
          : { freshnessExpiresAt: params.freshnessExpiresAt }),
        confidence,
        sensitivity: stale.sensitivity,
        provenance: {
          sourceRef: evidence.sourceIdentity,
          observedAt: evidence.observedAt,
          recordedAt: params.now,
          scopeKey: stale.scopeKey,
          confidence,
          sensitivity: stale.sensitivity,
          evidenceTaskId: evidence.taskId,
          evidenceTaskVersion: evidence.taskVersion,
          objectiveRevision: evidence.objectiveRevision,
          planVersion: evidence.planVersion,
        },
        content: safeContent,
        contentDigest: governorDigest(safeContent),
        verifiedEvidenceTaskId: evidence.taskId,
        verifiedEvidenceId: evidence.evidenceId,
        verifiedEvidenceDigest: evidence.evidenceDigest,
        verifiedEvidenceSemanticDigest: evidence.semanticDigest,
        supersedesId: stale.memoryId,
        createdAt: params.now,
        updatedAt: params.now,
      });
      if (!protectedReplacement.accepted) {
        return { kind: "rejected", reason: "replayed_evidence" };
      }
      const replacement = protectedReplacement.memory;
      const remediation: GovernorMemoryRemediation = {
        contradictionFingerprint: qualified.fingerprint,
        scopeKey: stale.scopeKey,
        factKey,
        contradictionClass,
        canonicalSourceRef: stale.provenance.sourceRef,
        staleMemoryId: stale.memoryId,
        replacementMemoryId,
        evidenceId: evidence.evidenceId,
        evidenceDigest: evidence.evidenceDigest,
        evidenceObservedAt: evidence.observedAt,
        status: "queued",
        repairEffectId: governorMemoryRepairEffectId(
          qualified.fingerprint,
          evidence.evidenceDigest,
        ),
        taskId: governorMemoryRemediationTaskId(existing, evidence.taskId),
        investigationCount: (existing?.investigationCount ?? 0) + 1,
        createdAt: existing?.createdAt ?? params.now,
        updatedAt: params.now,
      };
      const retired: GovernorMemoryRecord = {
        ...stale,
        status: "superseded",
        supersededAt: params.now,
        supersededEvidenceId: evidence.evidenceId,
        supersededEvidenceDigest: evidence.evidenceDigest,
        supersededReason: qualified.reason,
        contradictionFingerprint: qualified.fingerprint,
        replacementMemoryId,
        updatedAt: params.now,
      };
      const retiredUpdate = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memories")
          .set(bindGovernorMemory(retired))
          .where("memory_id", "=", stale.memoryId)
          .where("scope_key", "=", stale.scopeKey)
          .where("fact_key", "=", factKey)
          .where("scope_epoch", "=", currentEpoch)
          .where("status", "=", "verified"),
      );
      if (retiredUpdate.numAffectedRows !== 1n) {
        return { kind: "rejected", reason: "state_conflict" };
      }
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_memories").values(bindGovernorMemory(replacement)),
      );
      this.#authority.resolveRequirements(db, replacement, params.now);
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_memory_remediations")
          .values(bindGovernorMemoryRemediation(remediation))
          .onConflict((conflict) =>
            conflict
              .column("contradiction_fingerprint")
              .doUpdateSet(bindGovernorMemoryRemediation(remediation)),
          ),
      );
      return { kind: "retired", retired, replacement, remediation };
    }, this.#options);
  }

  load(fingerprint: string): GovernorMemoryRemediation | null {
    return this.#remediation(openOpenClawStateDatabase(this.#options).db, fingerprint);
  }

  list(scopeKey: string): GovernorMemoryRemediation[] {
    return listGovernorMemoryRemediations(openOpenClawStateDatabase(this.#options).db, scopeKey);
  }

  updateRepairState(params: {
    fingerprint: string;
    status: "repairing" | "blocked";
    blockedReason?: string;
    now: number;
    guard: GovernorMemoryRepairMutationGuard;
  }): GovernorMemoryRemediation | null {
    return updateGovernorMemoryRepairState({
      options: this.#options,
      tasks: this.#tasks,
      ...params,
    });
  }

  requeueRepair(params: {
    fingerprint: string;
    now: number;
    guard: GovernorMemoryRepairMutationGuard;
  }): GovernorMemoryRemediation | null {
    return requeueGovernorMemoryRepair({
      options: this.#options,
      tasks: this.#tasks,
      ...params,
    });
  }

  verifyRepair(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    fingerprint: string;
    now: number;
    guard: GovernorMemoryRepairMutationGuard;
  }): GovernorMemoryRemediation | null {
    assertGovernorPersistedJson("log", params);
    if (params.taskId !== params.guard.taskId) {
      throw new Error("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = this.#remediation(db, params.fingerprint);
      if (!current || !current.replacementMemoryId) {
        return null;
      }
      assertGovernorMemoryRepairMutationCurrent({
        db,
        current,
        guard: params.guard,
        tasks: this.#tasks,
      });
      const replacement = this.#currentReplacement(db, current, params.now);
      if (!replacement) {
        throw new Error("GOVERNOR_MEMORY_REPLACEMENT_NOT_CURRENT");
      }
      if (current.status === "verified") {
        if (current.verificationEvidenceId === params.evidenceId) {
          return current;
        }
        throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
      }
      if (
        current.status !== params.guard.expectedStatus ||
        current.updatedAt !== params.guard.expectedUpdatedAt
      ) {
        throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
      }
      const evidence = this.#evidence(db, params.taskId, params.evidenceId);
      const expectedPredicate = governorMemoryRepairPredicate(current.factKey);
      if (
        evidence.scopeKey !== current.scopeKey ||
        evidence.sourceIdentity !== current.canonicalSourceRef ||
        evidence.observedAt <= current.evidenceObservedAt ||
        evidence.predicate !== expectedPredicate ||
        governorDigest(evidence.value) !== replacement.contentDigest ||
        evidence.semanticDigest !==
          governorDigest({ predicate: expectedPredicate, value: evidence.value })
      ) {
        throw new Error("Governor memory repair requires fresh exact-source verification evidence");
      }
      const next: GovernorMemoryRemediation = {
        ...current,
        status: "verified",
        verificationEvidenceId: evidence.evidenceId,
        verificationEvidenceDigest: evidence.evidenceDigest,
        blockedReason: undefined,
        updatedAt: params.now,
        closedAt: params.now,
      };
      const update = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memory_remediations")
          .set(bindGovernorMemoryRemediation(next))
          .where("contradiction_fingerprint", "=", params.fingerprint)
          .where("task_id", "=", params.guard.taskId)
          .where("status", "=", params.guard.expectedStatus)
          .where("updated_at", "=", params.guard.expectedUpdatedAt),
      );
      if (update.numAffectedRows !== 1n) {
        throw new Error("GOVERNOR_MEMORY_REPAIR_CAS_REJECTED");
      }
      return next;
    }, this.#options);
  }
}
