// Validates that a contradiction replacement is still eligible and authoritative.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { governorDigest } from "./canonical-json.js";
import { loadCurrentGovernorEvidenceInTransaction } from "./current-evidence.js";
import type { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import {
  governorMemoryFactPredicate,
  normalizeGovernorFactKey,
} from "./memory-contradiction-policy.js";
import { parseGovernorMemory, parseGovernorScopeEpoch } from "./memory-record-codec.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";
import type { GovernorMemoryRecord } from "./memory-types.js";
import type { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";

type ReplacementDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_memories" | "governor_scope_epochs"
>;

const dbx = (db: DatabaseSync) => getNodeSqliteKysely<ReplacementDatabase>(db);

/** Returns the replacement only when every durable eligibility binding is still current. */
export function loadCurrentGovernorMemoryReplacement(params: {
  db: DatabaseSync;
  remediation: GovernorMemoryRemediation;
  admissions: GovernorEvidenceAdmissionStore;
  authority: GovernorMemoryAuthorityStore;
  tasks: GovernorTaskAuthorityStore;
  now: number;
}): GovernorMemoryRecord | null {
  const { db, remediation } = params;
  if (!remediation.replacementMemoryId) {
    return null;
  }
  const replacementRow = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_memories")
      .selectAll()
      .where("memory_id", "=", remediation.replacementMemoryId),
  );
  const staleRow = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_memories")
      .selectAll()
      .where("memory_id", "=", remediation.staleMemoryId),
  );
  if (!replacementRow || !staleRow) {
    return null;
  }
  const replacement = parseGovernorMemory(replacementRow);
  const stale = parseGovernorMemory(staleRow);
  const factKey = normalizeGovernorFactKey(remediation.factKey);
  const currentEpoch = parseGovernorScopeEpoch(
    executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_scope_epochs")
        .selectAll()
        .where("scope_key", "=", remediation.scopeKey),
    ),
  );
  const repairTask = params.tasks.loadCurrent(db, remediation.taskId);
  if (
    !repairTask ||
    repairTask.scopeKey !== remediation.scopeKey ||
    replacement.status !== "verified" ||
    replacement.scopeKey !== remediation.scopeKey ||
    replacement.scopeEpoch !== currentEpoch ||
    normalizeGovernorFactKey(replacement.factKey) !== factKey ||
    replacement.supersedesId !== remediation.staleMemoryId ||
    (replacement.freshnessExpiresAt !== undefined &&
      replacement.freshnessExpiresAt <= params.now) ||
    stale.status !== "superseded" ||
    stale.scopeKey !== remediation.scopeKey ||
    normalizeGovernorFactKey(stale.factKey) !== factKey ||
    stale.replacementMemoryId !== replacement.memoryId ||
    stale.contradictionFingerprint !== remediation.contradictionFingerprint
  ) {
    return null;
  }
  try {
    if (params.authority.state(replacement) !== "current") {
      return null;
    }
    if (!replacement.verifiedEvidenceTaskId || !replacement.verifiedEvidenceId) {
      return null;
    }
    const evidence = loadCurrentGovernorEvidenceInTransaction({
      db,
      admissions: params.admissions,
      taskId: replacement.verifiedEvidenceTaskId as import("./types.js").GovernorTaskId,
      evidenceId: replacement.verifiedEvidenceId,
      tasks: params.tasks,
    });
    if (
      evidence.scopeKey !== replacement.scopeKey ||
      evidence.evidenceId !== remediation.evidenceId ||
      evidence.evidenceDigest !== remediation.evidenceDigest ||
      evidence.evidenceDigest !== replacement.verifiedEvidenceDigest ||
      evidence.semanticDigest !== replacement.verifiedEvidenceSemanticDigest ||
      evidence.sourceIdentity !== replacement.sourceIdentity ||
      evidence.sourceIdentity !== replacement.provenance.sourceRef ||
      evidence.taskId !== replacement.provenance.evidenceTaskId ||
      evidence.taskVersion !== replacement.provenance.evidenceTaskVersion ||
      evidence.objectiveRevision !== replacement.provenance.objectiveRevision ||
      evidence.planVersion !== replacement.provenance.planVersion ||
      evidence.predicate !== governorMemoryFactPredicate(factKey) ||
      governorDigest(evidence.value) !== replacement.contentDigest
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return replacement;
}
