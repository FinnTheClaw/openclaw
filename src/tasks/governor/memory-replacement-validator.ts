// Validates that a contradiction replacement is still eligible and authoritative.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorMemoryAuthorityStore } from "./memory-authority.js";
import { normalizeGovernorFactKey } from "./memory-contradiction-policy.js";
import {
  assertCurrentGovernorMemory,
  assertHistoricalGovernorMemory,
} from "./memory-eligibility.js";
import { parseGovernorMemory } from "./memory-record-codec.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";
import { loadCurrentGovernorMemoryScopeEpoch } from "./memory-scope-epoch.js";
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
  try {
    const replacement = assertCurrentGovernorMemory({
      db,
      admissions: params.admissions,
      authority: params.authority,
      memory: parseGovernorMemory(replacementRow),
      tasks: params.tasks,
      now: params.now,
    });
    const stale = parseGovernorMemory(staleRow);
    assertHistoricalGovernorMemory({ db, memory: stale, admissions: params.admissions });
    const factKey = normalizeGovernorFactKey(remediation.factKey);
    const currentEpoch = loadCurrentGovernorMemoryScopeEpoch(db, remediation.scopeKey);
    const repairTask = params.tasks.loadCurrent(db, remediation.taskId);
    if (
      !repairTask ||
      repairTask.scopeKey !== remediation.scopeKey ||
      replacement.scopeKey !== remediation.scopeKey ||
      replacement.scopeEpoch !== currentEpoch ||
      normalizeGovernorFactKey(replacement.factKey) !== factKey ||
      replacement.supersedesId !== remediation.staleMemoryId ||
      replacement.verifiedEvidenceId !== remediation.evidenceId ||
      replacement.verifiedEvidenceDigest !== remediation.evidenceDigest ||
      stale.status !== "superseded" ||
      stale.scopeKey !== remediation.scopeKey ||
      normalizeGovernorFactKey(stale.factKey) !== factKey ||
      stale.replacementMemoryId !== replacement.memoryId ||
      stale.contradictionFingerprint !== remediation.contradictionFingerprint
    ) {
      return null;
    }
    return replacement;
  } catch {
    return null;
  }
}
