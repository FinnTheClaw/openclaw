// Kysely bindings and integrity checks for durable governor action intents.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { GovernorActionIntent } from "./action-intent.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorTaskId } from "./types.js";

type ActionIntentDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_tasks" | "governor_action_intents"
>;
type GovernorActionIntentRow = Selectable<OpenClawStateKyselyDatabase["governor_action_intents"]>;

export function actionIntentDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ActionIntentDatabase>(db);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid persisted governor ${label}`);
  }
}

export function bindGovernorActionIntent(
  intent: GovernorActionIntent,
): Insertable<GovernorActionIntentRow> {
  assertGovernorPersistedJson("log", intent);
  return {
    task_id: intent.taskId,
    effect_id: intent.effectId,
    idempotency_key: intent.idempotencyKey,
    task_version: intent.taskVersion,
    objective_revision: intent.objectiveRevision,
    plan_version: intent.planVersion,
    lease_epoch: intent.leaseEpoch,
    execution_generation: intent.executionGeneration,
    approval_required: intent.approvalRequired ? 1 : 0,
    approval_policy_digest: intent.approvalPolicyDigest,
    state: intent.state,
    claim_epoch: intent.claimEpoch,
    claimed_by: intent.claimedBy ?? null,
    lease_expires_at: intent.leaseExpiresAt ?? null,
    effect_started_at: intent.effectStartedAt ?? null,
    cancellation_requested_at: intent.cancellationRequestedAt ?? null,
    termination_outcome: intent.terminationOutcome ?? null,
    termination_evidence_digest: intent.terminationEvidenceDigest ?? null,
    termination_acknowledged_at: intent.terminationAcknowledgedAt ?? null,
    proposal_json: JSON.stringify(intent.proposal),
    proposal_digest: intent.proposalDigest,
    action_fingerprint: intent.actionFingerprint,
    progress_vector_hash: intent.progressVectorHash,
    force_replan_after_outcome: intent.forceReplanAfterOutcome ? 1 : 0,
    created_at: intent.createdAt,
    completed_at: intent.completedAt ?? null,
    cancelled_at: intent.cancelledAt ?? null,
    updated_at: intent.updatedAt,
  };
}

export function parseGovernorActionIntent(row: GovernorActionIntentRow): GovernorActionIntent {
  const proposal = parseJson(
    row.proposal_json,
    "action intent",
  ) as GovernorActionIntent["proposal"];
  const intent: GovernorActionIntent = {
    taskId: row.task_id as GovernorTaskId,
    effectId: row.effect_id,
    idempotencyKey: row.idempotency_key,
    taskVersion: normalizeSqliteNumber(row.task_version) ?? 0,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    planVersion: normalizeSqliteNumber(row.plan_version) ?? 0,
    leaseEpoch: normalizeSqliteNumber(row.lease_epoch) ?? 0,
    executionGeneration: normalizeSqliteNumber(row.execution_generation) ?? 0,
    approvalRequired: row.approval_required === 1,
    approvalPolicyDigest: row.approval_policy_digest,
    state: row.state as GovernorActionIntent["state"],
    claimEpoch: normalizeSqliteNumber(row.claim_epoch) ?? 0,
    ...(row.claimed_by == null ? {} : { claimedBy: row.claimed_by }),
    ...(row.lease_expires_at == null
      ? {}
      : { leaseExpiresAt: normalizeSqliteNumber(row.lease_expires_at) ?? 0 }),
    ...(row.effect_started_at == null
      ? {}
      : { effectStartedAt: normalizeSqliteNumber(row.effect_started_at) ?? 0 }),
    ...(row.cancellation_requested_at == null
      ? {}
      : {
          cancellationRequestedAt: normalizeSqliteNumber(row.cancellation_requested_at) ?? 0,
        }),
    ...(row.termination_outcome == null
      ? {}
      : {
          terminationOutcome: row.termination_outcome as GovernorActionIntent["terminationOutcome"],
        }),
    ...(row.termination_evidence_digest == null
      ? {}
      : { terminationEvidenceDigest: row.termination_evidence_digest }),
    ...(row.termination_acknowledged_at == null
      ? {}
      : {
          terminationAcknowledgedAt: normalizeSqliteNumber(row.termination_acknowledged_at) ?? 0,
        }),
    proposal,
    proposalDigest: row.proposal_digest,
    actionFingerprint: row.action_fingerprint,
    progressVectorHash: row.progress_vector_hash,
    forceReplanAfterOutcome: row.force_replan_after_outcome === 1,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(row.completed_at == null
      ? {}
      : { completedAt: normalizeSqliteNumber(row.completed_at) ?? 0 }),
    ...(row.cancelled_at == null
      ? {}
      : { cancelledAt: normalizeSqliteNumber(row.cancelled_at) ?? 0 }),
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
  if (
    governorDigest(proposal as unknown as GovernorJsonValue) !== intent.proposalDigest ||
    proposal.taskId !== intent.taskId ||
    proposal.effectId !== intent.effectId
  ) {
    throw new Error(`Persisted governor action intent mismatch for ${row.effect_id}`);
  }
  assertGovernorPersistedJson("log", intent);
  return intent;
}
