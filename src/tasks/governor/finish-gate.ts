// Deterministically accepts or rejects model-proposed task completion.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import {
  isGovernorEffectSemanticallySuccessful,
  type GovernorEffectRecord,
} from "./tool-outcome.js";
import type { GovernorTaskProjection } from "./types.js";

export type GovernorRecoveryDirective = {
  unmetCriteria: readonly string[];
  semanticFailures: readonly string[];
  contradictions: readonly string[];
  reconciliationEffectIds: readonly string[];
  unverifiedMutationEffectIds: readonly string[];
  prohibitedFingerprints: readonly string[];
  nextUsefulCapabilities: readonly string[];
};

export type GovernorCompletionCertificate = {
  taskId: string;
  objectiveRevision: number;
  planVersion: number;
  evidenceDigests: readonly string[];
  verifiedAt: number;
  certificateDigest: string;
};

export type GovernorFinishDecision =
  | { accepted: true; certificate: GovernorCompletionCertificate }
  | { accepted: false; recovery: GovernorRecoveryDirective };

function currentEvidence(params: {
  task: GovernorTaskProjection;
  evidence: readonly GovernorEvidenceRecord[];
}): GovernorEvidenceRecord[] {
  return params.evidence.filter(
    (item) =>
      item.objectiveRevision === params.task.objectiveRevision &&
      item.scopeKey === params.task.scopeKey &&
      item.admissibility === "admitted" &&
      item.invalidatedAt === undefined,
  );
}

export function evaluateGovernorFinish(params: {
  task: GovernorTaskProjection;
  effects: readonly GovernorEffectRecord[];
  evidence: readonly GovernorEvidenceRecord[];
  contradictions?: readonly string[];
  now: number;
}): GovernorFinishDecision {
  const evidence = currentEvidence(params);
  const supportedCriteria = new Set(evidence.map((item) => item.criterionId));
  const mandatoryCriteria = params.task.contract.completionCriteria.filter(
    (criterion) => criterion.mandatory,
  );
  const unmetCriteria = mandatoryCriteria
    .filter((criterion) => !supportedCriteria.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId);
  const currentEffects = params.effects.filter(
    (effect) => effect.objectiveRevision === params.task.objectiveRevision,
  );
  const reconciliationEffectIds = currentEffects
    .filter((effect) => effect.reconcileRequired)
    .map((effect) => effect.effectId);
  const unverifiedMutationEffectIds = currentEffects
    .filter((effect) => effect.mutating && effect.verificationState !== "verified")
    .map((effect) => effect.effectId);
  const semanticFailures = currentEffects
    .filter(
      (effect) =>
        !isGovernorEffectSemanticallySuccessful(effect) &&
        (!effect.criterionId || !supportedCriteria.has(effect.criterionId)),
    )
    .map((effect) => `${effect.effectId}:${effect.outcome.semantic}`);
  const contradictions = [...(params.contradictions ?? [])];
  if (
    unmetCriteria.length > 0 ||
    semanticFailures.length > 0 ||
    contradictions.length > 0 ||
    reconciliationEffectIds.length > 0 ||
    unverifiedMutationEffectIds.length > 0
  ) {
    const prohibitedFingerprints = currentEffects
      .filter((effect) => !isGovernorEffectSemanticallySuccessful(effect))
      .map((effect) => effect.actionFingerprint)
      .toSorted();
    return {
      accepted: false,
      recovery: {
        unmetCriteria,
        semanticFailures,
        contradictions,
        reconciliationEffectIds,
        unverifiedMutationEffectIds,
        prohibitedFingerprints,
        nextUsefulCapabilities: currentEffects
          .filter((effect) => !isGovernorEffectSemanticallySuccessful(effect))
          .map((effect) => effect.capability)
          .toSorted(),
      },
    };
  }
  const evidenceDigests = evidence.map((item) => item.evidenceDigest).toSorted();
  const certificatePayload = {
    taskId: params.task.taskId,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    evidenceDigests,
    verifiedAt: params.now,
  };
  return {
    accepted: true,
    certificate: {
      ...certificatePayload,
      certificateDigest: governorDigest(certificatePayload as GovernorJsonValue),
    },
  };
}
