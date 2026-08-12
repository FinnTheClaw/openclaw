// Provides the single fail-closed eligibility boundary for verified memory reads.
import type { DatabaseSync } from "node:sqlite";
import { governorDigest } from "./canonical-json.js";
import { loadCurrentGovernorEvidenceInTransaction } from "./current-evidence.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import type { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import { assertCanonicalGovernorMemoryRecord } from "./memory-record-codec.js";
import { loadCurrentGovernorMemoryScopeEpoch } from "./memory-scope-epoch.js";
import {
  GOVERNOR_MEMORY_SOURCE_RANK,
  type GovernorMemoryRecord,
  type GovernorMemorySourceKind,
} from "./memory-types.js";
import type { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import { loadGovernorEvidence } from "./store-queries.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import type { GovernorTaskId } from "./types.js";

function expectedConfidence(sourceKind: GovernorMemorySourceKind): number {
  return sourceKind === "structured_external"
    ? 1
    : sourceKind === "authenticated_user"
      ? 0.95
      : sourceKind === "tool"
        ? 0.9
        : 0;
}

function assertEvidenceBinding(
  memory: GovernorMemoryRecord,
  evidence: GovernorEvidenceRecord,
  allowInvalidated = false,
): void {
  const sourceKind = evidence.sourceKind as GovernorMemorySourceKind;
  if (
    (!allowInvalidated && evidence.invalidatedAt !== undefined) ||
    evidence.scopeKey !== memory.scopeKey ||
    evidence.evidenceDigest !== memory.verifiedEvidenceDigest ||
    evidence.semanticDigest !== memory.verifiedEvidenceSemanticDigest ||
    evidence.sourceKind !== memory.sourceKind ||
    evidence.sourceIdentity !== memory.sourceIdentity ||
    evidence.sourceIdentity !== memory.provenance.sourceRef ||
    evidence.observedAt !== memory.observedAt ||
    evidence.taskId !== memory.provenance.evidenceTaskId ||
    evidence.taskVersion !== memory.provenance.evidenceTaskVersion ||
    evidence.objectiveRevision !== memory.provenance.objectiveRevision ||
    evidence.planVersion !== memory.provenance.planVersion ||
    evidence.predicate !== governorMemoryFactPredicate(memory.factKey) ||
    governorDigest(evidence.value) !== memory.contentDigest ||
    governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
      memory.verifiedEvidenceSemanticDigest ||
    memory.sourceRank !== (GOVERNOR_MEMORY_SOURCE_RANK[sourceKind] ?? 0) ||
    memory.confidence !== expectedConfidence(sourceKind)
  ) {
    throw new Error("GOVERNOR_MEMORY_EVIDENCE_BINDING_INVALID");
  }
}

/** Authenticates an archived memory without treating it as current authority. */
export function assertHistoricalGovernorMemory(params: {
  db: DatabaseSync;
  memory: GovernorMemoryRecord;
  admissions: GovernorEvidenceAdmissionStore;
}): GovernorMemoryRecord {
  const memory = assertCanonicalGovernorMemoryRecord(params.memory);
  if (!memory.verifiedEvidenceTaskId || !memory.verifiedEvidenceId) {
    throw new Error("GOVERNOR_MEMORY_EVIDENCE_REQUIRED");
  }
  const evidence = loadGovernorEvidence(
    params.db,
    memory.verifiedEvidenceTaskId as GovernorTaskId,
    memory.verifiedEvidenceId,
    (record) => params.admissions.verify(record),
  );
  if (!evidence) {
    throw new Error("GOVERNOR_MEMORY_EVIDENCE_REQUIRED");
  }
  assertEvidenceBinding(memory, evidence, true);
  return memory;
}

/** Rejects any record that is not current under every persisted and host-owned binding. */
export function assertCurrentGovernorMemory(params: {
  db: DatabaseSync;
  memory: GovernorMemoryRecord;
  admissions: GovernorEvidenceAdmissionStore;
  authority: GovernorMemoryAuthorityStore;
  tasks: GovernorTaskAuthorityStore;
  now: number;
}): GovernorMemoryRecord {
  const memory = assertCanonicalGovernorMemoryRecord(params.memory);
  if (
    memory.status !== "verified" ||
    memory.scopeEpoch !== loadCurrentGovernorMemoryScopeEpoch(params.db, memory.scopeKey) ||
    (memory.freshnessExpiresAt !== undefined && memory.freshnessExpiresAt <= params.now) ||
    !memory.verifiedEvidenceTaskId ||
    !memory.verifiedEvidenceId ||
    !memory.verifiedEvidenceDigest ||
    !memory.verifiedEvidenceSemanticDigest
  ) {
    throw new Error("GOVERNOR_MEMORY_NOT_ELIGIBLE");
  }
  const evidence = loadCurrentGovernorEvidenceInTransaction({
    db: params.db,
    admissions: params.admissions,
    taskId: memory.verifiedEvidenceTaskId as GovernorTaskId,
    evidenceId: memory.verifiedEvidenceId,
    tasks: params.tasks,
  });
  assertEvidenceBinding(memory, evidence);
  if (params.authority.state(memory) !== "current") {
    throw new Error("GOVERNOR_MEMORY_BINDING_NOT_CURRENT");
  }
  return memory;
}
