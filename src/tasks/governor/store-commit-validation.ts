import { bindGovernorActionIntent } from "./action-intent-codec.js";
import type { GovernorActionIntentUpdate } from "./action-intent-store.js";
// Validates every caller-controlled commit field before host task-fence advancement.
import type { GovernorActionIntent } from "./action-intent.js";
import { governorDigest } from "./canonical-json.js";
import { bindGovernorCheckpoint } from "./checkpoint-store.js";
import type { GovernorEventRecord } from "./events.js";
import { bindGovernorOutbox, type GovernorOutboxRecord } from "./outbox-store.js";
import { assertGovernorPersistedJson, assertSameGovernorScope } from "./persistence-guard.js";
import type { GovernorCheckpoint } from "./planning-policy.js";
import { bindEffect, bindEvent, bindEvidence, bindTask } from "./store-codec.js";
import type { GovernorPendingEvidence } from "./store-evidence-admission.js";
import type { GovernorEffectRecord } from "./tool-outcome.js";
import { isOpaqueGovernorReference, type GovernorTaskProjection } from "./types.js";

export type GovernorEffectUpdate = {
  current: GovernorEffectRecord;
  next: GovernorEffectRecord;
};

export type GovernorCommitPayload = {
  current: GovernorTaskProjection;
  next: GovernorTaskProjection;
  event: GovernorEventRecord;
  effects?: readonly GovernorEffectRecord[];
  effectUpdates?: readonly GovernorEffectUpdate[];
  actionIntents?: readonly GovernorActionIntent[];
  actionIntentUpdates?: readonly GovernorActionIntentUpdate[];
  checkpoints?: readonly GovernorCheckpoint[];
  evidenceAdmission?: GovernorPendingEvidence;
  evidenceAdmissions?: readonly GovernorPendingEvidence[];
  outbox?: readonly GovernorOutboxRecord[];
};

type GovernorCommitValidators = {
  assertActionIntentPolicy: (task: GovernorTaskProjection, intent: GovernorActionIntent) => void;
  ownsEvidence: (pending: GovernorPendingEvidence) => boolean;
  verifyEvidence: (evidence: GovernorPendingEvidence["evidence"]) => void;
};

export function validateGovernorCommitPayload(
  params: GovernorCommitPayload,
  validators: GovernorCommitValidators,
): void {
  assertGovernorPersistedJson("log", {
    current: params.current,
    next: params.next,
    event: params.event,
    effects: [...(params.effects ?? [])],
    effectUpdates: [...(params.effectUpdates ?? [])],
    actionIntents: [...(params.actionIntents ?? [])],
    actionIntentUpdates: [...(params.actionIntentUpdates ?? [])],
    checkpoints: [...(params.checkpoints ?? [])],
    evidence: [
      ...(params.evidenceAdmissions ?? []),
      ...(params.evidenceAdmission ? [params.evidenceAdmission] : []),
    ].map((item) => item.evidence),
    outbox: [...(params.outbox ?? [])],
  });
  assertSameGovernorScope(params.current, params.current);
  assertSameGovernorScope(params.current, params.next);
  if (
    params.next.taskId !== params.current.taskId ||
    params.next.scopeKey !== params.current.scopeKey ||
    params.next.taskVersion !== params.current.taskVersion + 1 ||
    params.next.leaseEpoch < params.current.leaseEpoch ||
    params.next.leaseEpoch > params.current.leaseEpoch + 1 ||
    params.event.taskId !== params.next.taskId ||
    params.event.scopeKey !== params.next.scopeKey ||
    params.event.taskVersion !== params.next.taskVersion ||
    params.event.objectiveRevision !== params.next.objectiveRevision ||
    (params.next.flowId !== undefined && !isOpaqueGovernorReference(params.next.flowId)) ||
    (params.event.sourceMessageId !== undefined &&
      !isOpaqueGovernorReference(params.event.sourceMessageId)) ||
    params.event.payloadDigest !== governorDigest(params.event.payload)
  ) {
    throw new Error("GOVERNOR_COMMIT_ENVELOPE_INVALID");
  }
  bindTask(params.current);
  bindTask(params.next);
  bindEvent(params.event);

  for (const intent of params.actionIntents ?? []) {
    if (
      intent.taskId !== params.next.taskId ||
      intent.objectiveRevision !== params.next.objectiveRevision ||
      intent.planVersion !== params.next.planVersion ||
      intent.leaseEpoch !== params.next.leaseEpoch ||
      intent.executionGeneration !== params.next.executionGeneration ||
      intent.taskVersion < params.current.taskVersion ||
      intent.taskVersion > params.next.taskVersion
    ) {
      throw new Error("GOVERNOR_ACTION_INTENT_TASK_BINDING_INVALID");
    }
    validators.assertActionIntentPolicy(params.next, intent);
    bindGovernorActionIntent(intent);
  }
  for (const update of params.actionIntentUpdates ?? []) {
    if (
      update.current.taskId !== params.current.taskId ||
      update.next.taskId !== update.current.taskId ||
      update.next.effectId !== update.current.effectId ||
      update.next.objectiveRevision !== params.next.objectiveRevision ||
      update.next.planVersion !== params.next.planVersion ||
      update.next.leaseEpoch !== params.next.leaseEpoch ||
      update.next.executionGeneration !== params.next.executionGeneration ||
      update.next.updatedAt < update.current.updatedAt
    ) {
      throw new Error("GOVERNOR_ACTION_INTENT_UPDATE_INVALID");
    }
    validators.assertActionIntentPolicy(params.next, update.next);
    bindGovernorActionIntent(update.current);
    bindGovernorActionIntent(update.next);
  }
  for (const checkpoint of params.checkpoints ?? []) {
    if (
      checkpoint.taskId !== params.next.taskId ||
      checkpoint.objectiveRevision !== params.next.objectiveRevision ||
      checkpoint.planVersion !== params.next.planVersion ||
      checkpoint.taskVersion !== params.next.taskVersion
    ) {
      throw new Error("GOVERNOR_CHECKPOINT_TASK_BINDING_INVALID");
    }
    bindGovernorCheckpoint(checkpoint);
  }
  for (const effect of params.effects ?? []) {
    if (
      effect.taskId !== params.next.taskId ||
      effect.objectiveRevision !== params.next.objectiveRevision ||
      effect.planVersion !== params.next.planVersion ||
      effect.leaseEpoch !== params.next.leaseEpoch ||
      effect.executionGeneration !== params.next.executionGeneration ||
      effect.taskVersion < params.current.taskVersion ||
      effect.taskVersion > params.next.taskVersion
    ) {
      throw new Error("GOVERNOR_EFFECT_TASK_BINDING_INVALID");
    }
    bindEffect(effect);
  }
  for (const update of params.effectUpdates ?? []) {
    if (
      update.current.taskId !== params.current.taskId ||
      update.next.taskId !== update.current.taskId ||
      update.next.effectId !== update.current.effectId ||
      update.next.objectiveRevision !== params.next.objectiveRevision ||
      update.next.planVersion !== params.next.planVersion ||
      update.next.leaseEpoch !== params.next.leaseEpoch ||
      update.next.executionGeneration !== params.next.executionGeneration ||
      update.next.updatedAt < update.current.updatedAt
    ) {
      throw new Error("GOVERNOR_EFFECT_UPDATE_INVALID");
    }
    bindEffect(update.current);
    bindEffect(update.next);
  }
  const evidenceAdmissions = [
    ...(params.evidenceAdmissions ?? []),
    ...(params.evidenceAdmission ? [params.evidenceAdmission] : []),
  ];
  for (const evidenceAdmission of evidenceAdmissions) {
    const evidence = evidenceAdmission.evidence;
    if (!validators.ownsEvidence(evidenceAdmission)) {
      throw new Error("GOVERNOR_EVIDENCE_ADMISSION_UNTRUSTED");
    }
    if (
      evidence.taskId !== params.current.taskId ||
      evidence.scopeKey !== params.current.scopeKey ||
      evidence.objectiveRevision !== params.next.objectiveRevision ||
      evidence.planVersion !== params.next.planVersion ||
      evidence.taskVersion > params.current.taskVersion
    ) {
      throw new Error("GOVERNOR_EVIDENCE_ADMISSION_STALE");
    }
    validators.verifyEvidence(evidence);
    bindEvidence(evidence, validators.verifyEvidence);
  }
  for (const outbox of params.outbox ?? []) {
    if (
      outbox.taskId !== params.next.taskId ||
      outbox.taskVersion !== params.next.taskVersion ||
      outbox.objectiveRevision !== params.next.objectiveRevision ||
      outbox.planVersion !== params.next.planVersion ||
      outbox.leaseEpoch !== params.next.leaseEpoch ||
      outbox.executionGeneration !== params.next.executionGeneration
    ) {
      throw new Error("GOVERNOR_OUTBOX_TASK_BINDING_INVALID");
    }
    bindGovernorOutbox(outbox);
  }
}
