import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
// Atomic pre-effect and authenticated termination fences for governed actions.
import type {
  GovernorTrustedReceiptResolver,
  HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { reconcileRevokedGovernorActionIntent } from "./action-approval-reconciliation.js";
import {
  actionIntentDb,
  bindGovernorActionIntent,
  parseGovernorActionIntent,
} from "./action-intent-codec.js";
import type { GovernorActionIntent, GovernorActionTerminationOutcome } from "./action-intent.js";
import type { GovernorApprovalGrantStore, GovernorApprovalStatus } from "./approval-store.js";
import { governorDigest } from "./canonical-json.js";
import type { GovernorCapabilityRegistry } from "./capability-registry.js";
import { loadGovernorTask } from "./store-queries.js";
import type { GovernorIdentityContext, GovernorTaskId } from "./types.js";

export type GovernorActionLifecycleDependencies = Readonly<{
  options: OpenClawStateDatabaseOptions;
  approvals: GovernorApprovalGrantStore;
  capabilities: GovernorCapabilityRegistry;
  identity: GovernorIdentityContext;
  receipts: GovernorTrustedReceiptResolver;
}>;

export type GovernorBeginActionEffectResult =
  | { kind: "started"; intent: GovernorActionIntent }
  | { kind: "reconcile_required"; intent: GovernorActionIntent }
  | {
      kind: "stale_worker" | "approval_required" | "approval_stale" | "approval_revoked";
    };

export type GovernorActionTerminationResult =
  | { kind: "acknowledged"; intent: GovernorActionIntent }
  | { kind: "invalid" | "stale_worker" | "not_found" };

function approvalFailure(status: GovernorApprovalStatus) {
  return {
    kind:
      status === "missing"
        ? ("approval_required" as const)
        : status === "stale"
          ? ("approval_stale" as const)
          : ("approval_revoked" as const),
  };
}

function workerMatches(
  intent: GovernorActionIntent,
  params: { workerId: string; claimEpoch: number },
): boolean {
  return intent.claimedBy === params.workerId && intent.claimEpoch === params.claimEpoch;
}

export function beginGovernorActionEffect(
  dependencies: GovernorActionLifecycleDependencies,
  params: {
    taskId: GovernorTaskId;
    effectId: string;
    workerId: string;
    claimEpoch: number;
    objectiveRevision: number;
    planVersion: number;
    leaseEpoch: number;
    executionGeneration: number;
    now: number;
  },
): GovernorBeginActionEffectResult {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const task = loadGovernorTask(db, params.taskId);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      actionIntentDb(db)
        .selectFrom("governor_action_intents")
        .selectAll()
        .where("task_id", "=", params.taskId)
        .where("effect_id", "=", params.effectId),
    );
    if (!task || !row) {
      return { kind: "stale_worker" };
    }
    const intent = parseGovernorActionIntent(row);
    if (
      task.state !== "EXECUTING" ||
      task.objectiveRevision !== params.objectiveRevision ||
      task.planVersion !== params.planVersion ||
      task.leaseEpoch !== params.leaseEpoch ||
      task.executionGeneration !== params.executionGeneration ||
      intent.state !== "running" ||
      !workerMatches(intent, params) ||
      intent.objectiveRevision !== params.objectiveRevision ||
      intent.planVersion !== params.planVersion ||
      intent.leaseEpoch !== params.leaseEpoch ||
      intent.executionGeneration !== params.executionGeneration ||
      intent.leaseExpiresAt === undefined ||
      intent.leaseExpiresAt <= params.now ||
      intent.cancellationRequestedAt !== undefined ||
      intent.terminationOutcome !== undefined
    ) {
      return { kind: "stale_worker" };
    }
    if (intent.effectStartedAt !== undefined) {
      return { kind: "reconcile_required", intent };
    }
    try {
      dependencies.capabilities.assertPersistedIntentAuthorized(
        task,
        intent.proposal,
        dependencies.identity,
      );
    } catch {
      return { kind: "stale_worker" };
    }
    const policy = dependencies.capabilities.approvalPolicy(intent.proposal);
    if (
      intent.approvalRequired !== policy.required ||
      intent.approvalPolicyDigest !== policy.digest
    ) {
      return { kind: "stale_worker" };
    }
    if (intent.approvalRequired) {
      const approval = dependencies.approvals.statusWithinTransaction(
        db,
        {
          taskId: intent.taskId,
          scopeKey: task.scopeKey,
          objectiveRevision: intent.objectiveRevision,
        },
        intent.proposal,
        params.now,
      );
      if (approval !== "approved") {
        if (approval === "revoked") {
          reconcileRevokedGovernorActionIntent(db, intent, params.now);
        }
        return approvalFailure(approval);
      }
    }
    const started = { ...intent, effectStartedAt: params.now, updatedAt: params.now };
    const update = executeSqliteQuerySync(
      db,
      actionIntentDb(db)
        .updateTable("governor_action_intents")
        .set(bindGovernorActionIntent(started))
        .where("task_id", "=", intent.taskId)
        .where("effect_id", "=", intent.effectId)
        .where("claim_epoch", "=", intent.claimEpoch)
        .where("updated_at", "=", intent.updatedAt)
        .where("effect_started_at", "is", null),
    );
    return update.numAffectedRows === 1n
      ? { kind: "started", intent: started }
      : { kind: "stale_worker" };
  }, dependencies.options);
}

export function governorActionTerminationReceiptPayload(
  intent: GovernorActionIntent,
  outcome: GovernorActionTerminationOutcome,
) {
  return {
    kind: "governor_action_effect_termination",
    taskId: intent.taskId,
    effectId: intent.effectId,
    taskVersion: intent.taskVersion,
    objectiveRevision: intent.objectiveRevision,
    planVersion: intent.planVersion,
    leaseEpoch: intent.leaseEpoch,
    executionGeneration: intent.executionGeneration,
    claimEpoch: intent.claimEpoch,
    workerIdentity: governorDigest({ workerId: intent.claimedBy ?? "" }),
    outcome,
  } as const;
}

function validTerminationTransition(
  intent: GovernorActionIntent,
  outcome: GovernorActionTerminationOutcome,
): boolean {
  if (intent.terminationOutcome === "unknown") {
    return outcome === "confirmed_not_applied" || outcome === "confirmed_applied";
  }
  if (intent.terminationOutcome !== undefined || intent.state !== "running") {
    return false;
  }
  if (outcome === "cancelled_before_effect") {
    return intent.effectStartedAt === undefined;
  }
  return outcome === "unknown" && intent.effectStartedAt !== undefined;
}

export function acknowledgeGovernorActionTermination(
  dependencies: GovernorActionLifecycleDependencies,
  params: {
    taskId: GovernorTaskId;
    effectId: string;
    receiptId: HostGovernorReceiptId;
    outcome: GovernorActionTerminationOutcome;
    now: number;
  },
): GovernorActionTerminationResult {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const task = loadGovernorTask(db, params.taskId);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      actionIntentDb(db)
        .selectFrom("governor_action_intents")
        .selectAll()
        .where("task_id", "=", params.taskId)
        .where("effect_id", "=", params.effectId),
    );
    if (!task || !row) {
      return { kind: "not_found" };
    }
    const intent = parseGovernorActionIntent(row);
    const payload = governorActionTerminationReceiptPayload(intent, params.outcome);
    const evidenceDigest = governorDigest({ receiptId: params.receiptId, payload });
    if (
      intent.terminationOutcome === params.outcome &&
      intent.terminationEvidenceDigest === evidenceDigest
    ) {
      return { kind: "acknowledged", intent };
    }
    const receipt = dependencies.receipts.resolve(params.receiptId, task.scopeKey);
    if (
      !receipt ||
      !validTerminationTransition(intent, params.outcome) ||
      intent.cancellationRequestedAt === undefined ||
      receipt.taskId !== intent.taskId ||
      receipt.taskVersion !== intent.taskVersion ||
      receipt.objectiveRevision !== intent.objectiveRevision ||
      receipt.planVersion !== intent.planVersion ||
      receipt.sourceKind !== "structured_external" ||
      receipt.observedAt < intent.cancellationRequestedAt ||
      receipt.observedAt > params.now ||
      governorDigest(receipt.payload) !== governorDigest(payload)
    ) {
      return { kind: "invalid" };
    }
    const terminal: GovernorActionIntent = {
      ...intent,
      state: "cancelled",
      terminationOutcome: params.outcome,
      terminationEvidenceDigest: evidenceDigest,
      terminationAcknowledgedAt: params.now,
      cancelledAt: intent.cancelledAt ?? params.now,
      updatedAt: params.now,
    };
    delete terminal.leaseExpiresAt;
    const update = executeSqliteQuerySync(
      db,
      actionIntentDb(db)
        .updateTable("governor_action_intents")
        .set(bindGovernorActionIntent(terminal))
        .where("task_id", "=", intent.taskId)
        .where("effect_id", "=", intent.effectId)
        .where("claim_epoch", "=", intent.claimEpoch)
        .where("updated_at", "=", intent.updatedAt),
    );
    return update.numAffectedRows === 1n
      ? { kind: "acknowledged", intent: terminal }
      : { kind: "stale_worker" };
  }, dependencies.options);
}
