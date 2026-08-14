/**
 * Subagent registry record types.
 *
 * Defines execution, completion, delivery, pending-delivery, and attachment state stored for child runs.
 */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type PendingFinalDeliveryPayload = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  frozenResultText?: string | null;
  fallbackFrozenResultText?: string | null;
  wakeOnDescendantSettle?: boolean;
};

export type SubagentExecutionState = {
  status: "running" | "interrupted" | "terminal";
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart" | "lost-execution-context";
  transcriptFile?: string;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
};

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "retry-limit" | "expiry";
  discardedAt?: number;
  discardReason?: "expired" | "pressure-pruned";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "dedupe"
    | "waiting_for_requester_turn";
};

/**
 * Durable barrier shared by native subagents admitted from one batch tool call.
 *
 * Batch members execute independently, but completion delivery is withheld until
 * every accepted member settles. The deterministic leader then wakes the
 * requester once with an aggregate settlement summary.
 */
export type SubagentCompletionGroupState = {
  id: string;
  index: number;
  expectedSize: number;
  finalized: boolean;
  activatedAt?: number;
  leaderRunId?: string;
};

type SubagentKillReconciliationState = {
  /** Actual cancellation time; a yielded run may have an older execution end. */
  killedAt: number;
  /** Requester aborts must not re-inject a delayed completion after queues are cleared. */
  suppressTaskDelivery?: boolean;
  /** Durable ownership boundary even after the newer registry row is released. */
  supersededAt?: number;
};

export type SubagentRunRecord = {
  runId: string;
  /** Stable host-owned logical child identity, distinct from provider runId. */
  childIntentKey?: string;
  /** Durable admission state; unknown means provider acceptance is unresolved. */
  spawnAdmission?: "reserved" | "dispatching" | "dispatched" | "unknown" | "cancelled" | "expired";
  /** Host-owned behavior binding; a reused logical key with a changed value fails closed. */
  childIntentBehaviorDigest?: string;
  /** Immutable pre-dispatch preparation binding; distinct from final resolution. */
  childIntentPreparationDigest?: string;
  /** Stable caller request binding, distinct from the resolved execution digest. */
  childIntentRequestDigest?: string;
  /** Explicit operation identity is stable and is not part of the behavior digest. */
  childIntentOperationKey?: string;
  childIntentLookupKey?: string;
  childIntentTargetAgentId?: string;
  /** Durable reservation owner and lease, unlike the process-local registry token. */
  reservationOwnerToken?: string;
  reservationExpiresAt?: number;
  /** Provider run id retained when registration failed after dispatch acceptance. */
  providerRunId?: string;
  /** Durable gateway acceptance receipt bound before child registration. */
  gatewayReceiptId?: string;
  /** Detached task owner; steer/restart changes runId but continues the same task. */
  taskRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  /** Immutable root assignment retained when steer restarts rotate the child session. */
  originalTask?: string;
  /** Ordered steering deltas needed to reconstruct context after a restart. */
  steeringMessages?: string[];
  /** Number of oldest steering deltas omitted by the bounded history policy. */
  steeringHistoryOmittedCount?: number;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  /** Monotonic ownership generation within one child session. */
  generation?: number;
  /** SQLite-owned projection CAS revision. */
  projectionRevision?: number;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  /** Present only while a current-version killed run awaits bounded reconciliation. */
  killReconciliation?: SubagentKillReconciliationState;
  /** Durable requester-stop policy until silent completion cleanup finishes. */
  suppressCompletionDelivery?: boolean;
  expectsCompletionMessage?: boolean;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  execution?: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Set immediately before irreversible sessions.delete cleanup is dispatched. */
  deleteCleanupDispatchedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  /** Optional batch-completion barrier for concurrently admitted child runs. */
  completionGroup?: SubagentCompletionGroupState;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
