import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  GovernorTrustedEvidenceInvalidationResolver,
  HostGovernorEvidenceInvalidationReceiptId,
} from "../../security/governor-host-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { createGovernorEventRecord } from "./events.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import {
  bindGovernorOutbox,
  parseGovernorOutbox,
  type GovernorOutboxRecord,
} from "./outbox-codec.js";
import {
  bindEvidence,
  bindEvent,
  governorDb,
  parseEvidenceRow,
  parseEventRow,
} from "./store-codec.js";
import { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import { loadGovernorTask } from "./store-queries.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorTaskId } from "./types.js";

export type { GovernorEvidenceInvalidationReason } from "../../security/governor-host-contracts.js";

export function invalidateGovernorEvidence(params: {
  options: OpenClawStateDatabaseOptions;
  admissions: GovernorEvidenceAdmissionStore;
  tasks: GovernorTaskAuthorityStore;
  resolver: GovernorTrustedEvidenceInvalidationResolver;
  taskId: GovernorTaskId;
  evidenceId: string;
  receiptId: HostGovernorEvidenceInvalidationReceiptId;
}): GovernorEvidenceRecord {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const task = loadGovernorTask(db, params.taskId, params.tasks);
    if (!task) {
      throw new Error("GOVERNOR_TASK_NOT_FOUND");
    }
    const allEvidence = executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_evidence")
        .selectAll()
        .where("task_id", "=", params.taskId),
    ).rows.map((row) => parseEvidenceRow(row, (record) => params.admissions.verify(record)));
    const evidence = allEvidence.find((record) => record.evidenceId === params.evidenceId);
    if (!evidence) {
      throw new Error("GOVERNOR_EVIDENCE_NOT_FOUND");
    }
    const previousEvents = executeSqliteQuerySync(
      db,
      governorDb(db)
        .selectFrom("governor_events")
        .selectAll()
        .where("task_id", "=", params.taskId)
        .where("event_type", "=", "evidence_invalidated")
        .orderBy("created_at", "asc"),
    ).rows.map(parseEventRow);
    const exactPersistedReplay = previousEvents.some((event) => {
      const payload = event.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.evidenceId === evidence.evidenceId &&
        payload.evidenceDigest === evidence.evidenceDigest &&
        payload.receiptId === params.receiptId &&
        typeof payload.reasonCode === "string" &&
        typeof payload.provenanceDigest === "string"
      );
    });
    if (evidence.invalidatedAt !== undefined && exactPersistedReplay) {
      return evidence;
    }
    const receipt = params.resolver.resolveEvidenceInvalidation(params.receiptId, task.scopeKey);
    if (!receipt) {
      throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_RECEIPT_INVALID");
    }
    if (
      receipt.taskId !== task.taskId ||
      receipt.taskVersion !== task.taskVersion ||
      receipt.objectiveRevision !== task.objectiveRevision ||
      receipt.planVersion !== task.planVersion ||
      receipt.evidenceId !== evidence.evidenceId ||
      receipt.evidenceDigest !== evidence.evidenceDigest ||
      receipt.observedAt < evidence.observedAt ||
      evidence.taskVersion > task.taskVersion ||
      evidence.objectiveRevision !== task.objectiveRevision ||
      receipt.planVersion !== task.planVersion
    ) {
      throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_BINDING_INVALID");
    }
    if (evidence.invalidatedAt !== undefined) {
      const existing = previousEvents.find((event) => {
        const payload = event.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload.evidenceId === evidence.evidenceId
        );
      });
      if (
        existing &&
        typeof existing.payload === "object" &&
        existing.payload !== null &&
        !Array.isArray(existing.payload) &&
        existing.payload.receiptId === receipt.id &&
        existing.payload.evidenceDigest === receipt.evidenceDigest &&
        existing.payload.reasonCode === receipt.reasonCode &&
        existing.payload.provenanceDigest === receipt.provenanceDigest
      ) {
        return evidence;
      }
      throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_CONFLICT");
    }
    const hasCurrentDescendant = allEvidence.some((candidate) => {
      const visited = new Set<string>();
      let current = candidate;
      while (current.sourceEvidenceId) {
        if (visited.has(current.evidenceId)) {
          throw new Error("GOVERNOR_EVIDENCE_LINEAGE_CYCLE");
        }
        visited.add(current.evidenceId);
        if (current.sourceEvidenceId === evidence.evidenceId) {
          return (
            candidate.invalidatedAt === undefined &&
            candidate.objectiveRevision === task.objectiveRevision &&
            candidate.planVersion === task.planVersion
          );
        }
        const parent = allEvidence.find((item) => item.evidenceId === current.sourceEvidenceId);
        if (!parent) {
          throw new Error("GOVERNOR_EVIDENCE_LINEAGE_SOURCE_MISMATCH");
        }
        current = parent;
      }
      return false;
    });
    if (
      evidence.scopeKey !== task.scopeKey ||
      evidence.objectiveRevision !== task.objectiveRevision ||
      evidence.taskVersion > task.taskVersion ||
      (evidence.planVersion !== task.planVersion && !hasCurrentDescendant)
    ) {
      throw new Error("GOVERNOR_EVIDENCE_NOT_CURRENT");
    }
    if (
      receipt.reasonCode === "contradicted_by_newer_evidence" &&
      (receipt.provenance.kind !== "newer_evidence" ||
        receipt.provenance.sourceEvidenceId === evidence.evidenceId ||
        receipt.provenance.sourceObservedAt <= evidence.observedAt ||
        receipt.provenance.sourceScopeKey !== task.scopeKey)
    ) {
      throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_PROVENANCE_INVALID");
    }
    const invalidationAt = receipt.observedAt;
    if (task.state === "COMPLETED" || task.terminalAt !== undefined) {
      const outboxRows = executeSqliteQuerySync(
        db,
        governorDb(db).selectFrom("governor_outbox").selectAll().where("task_id", "=", task.taskId),
      ).rows.map(parseGovernorOutbox);
      if (outboxRows.some((entry) => entry.state === "sent")) {
        throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_AFTER_DELIVERY");
      }
      if (outboxRows.some((entry) => entry.state === "claimed")) {
        throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_DELIVERY_IN_FLIGHT");
      }
      for (const entry of outboxRows) {
        if (entry.state === "manual_review" || entry.state === "would_send") {
          continue;
        }
        const fenced: GovernorOutboxRecord = {
          ...entry,
          state: "manual_review",
          providerReceipt: {
            ...(entry.providerReceipt &&
            typeof entry.providerReceipt === "object" &&
            !Array.isArray(entry.providerReceipt)
              ? entry.providerReceipt
              : {}),
            invalidatedEvidenceDigest: receipt.evidenceDigest,
            invalidationReasonCode: receipt.reasonCode,
          },
          updatedAt: invalidationAt,
        };
        delete fenced.leaseExpiresAt;
        executeSqliteQuerySync(
          db,
          governorDb(db)
            .updateTable("governor_outbox")
            .set(bindGovernorOutbox(fenced))
            .where("task_id", "=", task.taskId)
            .where("effect_id", "=", entry.effectId)
            .where("state", "!=", "sent"),
        );
      }
    }
    const invalidatedIds = new Set<string>();
    const invalidateRecord = (record: GovernorEvidenceRecord, derivedFromEvidenceId?: string) => {
      const invalidatedRecord = params.admissions.invalidate(record, invalidationAt);
      const update = executeSqliteQuerySync(
        db,
        governorDb(db)
          .updateTable("governor_evidence")
          .set(bindEvidence(invalidatedRecord, (candidate) => params.admissions.verify(candidate)))
          .where("task_id", "=", params.taskId)
          .where("evidence_id", "=", record.evidenceId)
          .where("admission_signature", "=", record.admissionSignature)
          .where("invalidated_at", "is", null),
      );
      if (update.numAffectedRows !== 1n) {
        throw new Error("GOVERNOR_EVIDENCE_INVALIDATION_CONFLICT");
      }
      const event = createGovernorEventRecord({
        task,
        eventType: "evidence_invalidated",
        payload: {
          evidenceId: record.evidenceId,
          evidenceDigest: record.evidenceDigest,
          reasonCode: receipt.reasonCode,
          receiptId: receipt.id,
          provenanceDigest: receipt.provenanceDigest,
          ...(derivedFromEvidenceId ? { derivedFromEvidenceId } : {}),
        },
        now: invalidationAt,
      });
      executeSqliteQuerySync(
        db,
        governorDb(db).insertInto("governor_events").values(bindEvent(event)),
      );
      invalidatedIds.add(record.evidenceId);
      return invalidatedRecord;
    };
    const invalidated = invalidateRecord(evidence);
    const pending = [evidence.evidenceId];
    while (pending.length > 0) {
      const ancestorId = pending.shift()!;
      for (const dependent of allEvidence) {
        if (dependent.invalidatedAt !== undefined || invalidatedIds.has(dependent.evidenceId)) {
          continue;
        }
        const payload = dependent.payload;
        const ancestorCriterionId = allEvidence.find(
          (item) => item.evidenceId === ancestorId,
        )?.criterionId;
        const dependsOnCriterion =
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          Array.isArray(payload.dependsOnCriteria) &&
          typeof ancestorCriterionId === "string" &&
          payload.dependsOnCriteria.some((value: unknown) => value === ancestorCriterionId);
        if (dependent.sourceEvidenceId !== ancestorId && !dependsOnCriterion) {
          continue;
        }
        invalidateRecord(dependent, ancestorId);
        pending.push(dependent.evidenceId);
      }
    }
    return invalidated;
  }, params.options);
}
