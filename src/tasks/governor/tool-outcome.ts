import type {
  GovernorActionProposal,
  GovernorEffectRecord,
  GovernorToolOutcome,
} from "./action-contracts.js";
import { createGovernorActionFingerprint } from "./action-fingerprint.js";
// Separates tool transport, semantic, side-effect, and verification outcomes.
import type { GovernorJsonValue } from "./canonical-json.js";
import { governorDigest } from "./canonical-json.js";
import { governorProgressVectorHash } from "./progress-monitor.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorIdentityContext } from "./types.js";

export type {
  GovernorActionProposal,
  GovernorEffectRecord,
  GovernorSemanticOutcome,
  GovernorToolOutcome,
} from "./action-contracts.js";

export { createGovernorActionFingerprint } from "./action-fingerprint.js";

export function createGovernorEffectRecord(params: {
  proposal: GovernorActionProposal;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  progressVector: GovernorJsonValue;
  outcome: GovernorToolOutcome;
  now: number;
  identity: GovernorIdentityContext;
}): GovernorEffectRecord {
  const safeProposal = assertGovernorBoundarySafe(
    "log",
    params.proposal as unknown as GovernorJsonValue,
  ) as unknown as GovernorActionProposal;
  const safeOutcome = assertGovernorBoundarySafe(
    "model",
    params.outcome as unknown as GovernorJsonValue,
  ) as unknown as GovernorToolOutcome;
  const reconcileRequired =
    safeProposal.mutating &&
    (safeOutcome.transport === "unknown" || safeOutcome.sideEffect === "unknown");
  const verificationState = safeProposal.mutating
    ? safeOutcome.verification === "verified"
      ? "verified"
      : "required"
    : safeOutcome.verification;
  return {
    ...safeProposal,
    idempotencyKey: governorDigest({
      taskId: safeProposal.taskId,
      effectId: safeProposal.effectId,
      objectiveRevision: params.objectiveRevision,
      planVersion: params.planVersion,
      executionGeneration: params.executionGeneration,
    }),
    taskVersion: params.taskVersion,
    objectiveRevision: params.objectiveRevision,
    planVersion: params.planVersion,
    leaseEpoch: params.leaseEpoch,
    executionGeneration: params.executionGeneration,
    actionFingerprint: createGovernorActionFingerprint(safeProposal, params.identity),
    progressVectorHash: governorProgressVectorHash(params.progressVector),
    outcome: safeOutcome,
    verificationState,
    reconcileRequired,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function isGovernorEffectSemanticallySuccessful(effect: GovernorEffectRecord): boolean {
  return (
    effect.outcome.transport === "completed" &&
    effect.outcome.semantic === "success" &&
    !effect.reconcileRequired
  );
}
