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
import {
  bindGovernorMemoryRemediation,
  parseGovernorMemoryRemediation,
  type GovernorMemoryRemediation,
} from "./memory-remediation.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import {
  isGovernorEvidenceAdmissionStore,
  type GovernorEvidenceAdmissionStore,
} from "./store-evidence-admission.js";
import type { GovernorTaskId } from "./types.js";

type ContradictionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_memory_remediations"
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

  constructor(params: {
    options: OpenClawStateDatabaseOptions;
    evidenceAdmissions: GovernorEvidenceAdmissionStore;
  }) {
    if (!isGovernorEvidenceAdmissionStore(params.evidenceAdmissions)) {
      throw new Error("Governor memory contradiction store requires its evidence admission owner");
    }
    this.#options = params.options;
    this.#admissions = params.evidenceAdmissions;
  }

  #evidence(db: DatabaseSync, taskId: GovernorTaskId, evidenceId: string) {
    return loadCurrentGovernorEvidenceInTransaction({
      db,
      admissions: this.#admissions,
      taskId,
      evidenceId,
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

  resolve(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    staleMemoryId: string;
    contradictionClass: string;
    freshnessExpiresAt?: number;
    now: number;
  }): GovernorMemoryContradictionResolution {
    return runOpenClawStateWriteTransaction(({ db }) => {
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
      const activeFactRows = executeSqliteQuerySync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .select(["memory_id"])
          .where("scope_key", "=", stale.scopeKey)
          .where("fact_key", "=", factKey)
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
          const replacementRow = executeSqliteQueryTakeFirstSync(
            db,
            dbx(db)
              .selectFrom("governor_memories")
              .selectAll()
              .where("memory_id", "=", existing.replacementMemoryId),
          );
          if (replacementRow && existing.evidenceDigest === evidence.evidenceDigest) {
            return {
              kind: "duplicate",
              retired: stale,
              replacement: parseGovernorMemory(replacementRow),
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
        const replacementRow = executeSqliteQueryTakeFirstSync(
          db,
          dbx(db)
            .selectFrom("governor_memories")
            .selectAll()
            .where("memory_id", "=", existing.replacementMemoryId),
        );
        if (replacementRow) {
          return {
            kind: "duplicate",
            retired: stale,
            replacement: parseGovernorMemory(replacementRow),
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
      const replacement: GovernorMemoryRecord = {
        memoryId: replacementMemoryId,
        scopeKey: stale.scopeKey,
        scopeEpoch: stale.scopeEpoch,
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
          scopeKey: stale.scopeKey,
          confidence,
          sensitivity: stale.sensitivity,
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
      };
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
          .where("status", "=", "verified"),
      );
      if (retiredUpdate.numAffectedRows !== 1n) {
        return { kind: "rejected", reason: "state_conflict" };
      }
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_memories").values(bindGovernorMemory(replacement)),
      );
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
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      dbx(db)
        .selectFrom("governor_memory_remediations")
        .selectAll()
        .where("scope_key", "=", scopeKey)
        .orderBy("created_at", "asc")
        .orderBy("contradiction_fingerprint", "asc"),
    ).rows.map(parseGovernorMemoryRemediation);
  }

  updateRepairState(params: {
    fingerprint: string;
    status: "repairing" | "blocked";
    blockedReason?: string;
    now: number;
  }): GovernorMemoryRemediation | null {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = this.#remediation(db, params.fingerprint);
      if (!current || current.status === "verified") {
        return current;
      }
      const next: GovernorMemoryRemediation = {
        ...current,
        status: params.status,
        ...(params.status === "blocked"
          ? { blockedReason: params.blockedReason?.trim() || "repair_failed" }
          : { blockedReason: undefined }),
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memory_remediations")
          .set(bindGovernorMemoryRemediation(next))
          .where("contradiction_fingerprint", "=", params.fingerprint),
      );
      return next;
    }, this.#options);
  }

  requeueRepair(params: {
    fingerprint: string;
    taskId: GovernorMemoryRemediation["taskId"];
    now: number;
  }): GovernorMemoryRemediation | null {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = this.#remediation(db, params.fingerprint);
      if (!current || current.status !== "blocked" || current.taskId !== params.taskId) {
        return current;
      }
      const next: GovernorMemoryRemediation = {
        ...current,
        status: "queued",
        blockedReason: undefined,
        updatedAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memory_remediations")
          .set(bindGovernorMemoryRemediation(next))
          .where("contradiction_fingerprint", "=", params.fingerprint)
          .where("status", "=", "blocked"),
      );
      return next;
    }, this.#options);
  }

  verifyRepair(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    fingerprint: string;
    now: number;
  }): GovernorMemoryRemediation | null {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const evidence = this.#evidence(db, params.taskId, params.evidenceId);
      const current = this.#remediation(db, params.fingerprint);
      if (!current || !current.replacementMemoryId) {
        return null;
      }
      if (current.status === "verified") {
        return current;
      }
      const replacementRow = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_memories")
          .selectAll()
          .where("memory_id", "=", current.replacementMemoryId),
      );
      if (!replacementRow) {
        return null;
      }
      const replacement = parseGovernorMemory(replacementRow);
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
      executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_memory_remediations")
          .set(bindGovernorMemoryRemediation(next))
          .where("contradiction_fingerprint", "=", params.fingerprint),
      );
      return next;
    }, this.#options);
  }
}
