// Deterministically accepts or rejects model-proposed task completion.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorEvidenceRecord } from "./evidence.js";
import type { GovernorResponseDraft } from "./material-claims.js";
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
  runningActionIds: readonly string[];
  pendingUserUpdate: boolean;
  unsupportedMaterialClaimIds: readonly string[];
  prohibitedFingerprints: readonly string[];
  nextUsefulCapabilities: readonly string[];
};

export type GovernorCompletionCertificate = {
  taskId: string;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
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
      item.planVersion === params.task.planVersion &&
      item.scopeKey === params.task.scopeKey &&
      item.admissibility === "admitted" &&
      item.invalidatedAt === undefined,
  );
}

export function evaluateGovernorFinish(params: {
  task: GovernorTaskProjection;
  effects: readonly GovernorEffectRecord[];
  evidence: readonly GovernorEvidenceRecord[];
  runningActionIds?: readonly string[];
  response: GovernorResponseDraft;
  now: number;
}): GovernorFinishDecision {
  const evidence = currentEvidence(params);
  const supportedCriteria = new Set(evidence.map((item) => item.criterionId));
  const currentClaims = params.task.claims.filter(
    (claim) =>
      claim.objectiveRevision === params.task.objectiveRevision &&
      claim.planVersion === params.task.planVersion &&
      claim.scopeKey === params.task.scopeKey,
  );
  const supportedClaims = new Set(
    currentClaims.filter((claim) => claim.kind !== "material").map((claim) => claim.claimId),
  );
  const mandatoryCriteria = params.task.contract.completionCriteria.filter(
    (criterion) => criterion.mandatory,
  );
  const unmetCriteria = mandatoryCriteria
    .filter(
      (criterion) =>
        !supportedCriteria.has(criterion.criterionId) ||
        !supportedClaims.has(criterion.criterionId),
    )
    .map((criterion) => criterion.criterionId);
  const currentEffects = params.effects.filter(
    (effect) =>
      effect.objectiveRevision === params.task.objectiveRevision &&
      effect.planVersion === params.task.planVersion &&
      effect.executionGeneration === params.task.executionGeneration,
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
  const contradictions = params.task.conditions.contradictions
    .filter((item) => item.severity === "high")
    .map((item) => item.detail);
  const runningActionIds = [...(params.runningActionIds ?? [])];
  const pendingUserUpdate = params.task.conditions.pendingUserUpdate;
  const currentEvidenceIds = new Set(evidence.map((item) => item.evidenceId));
  const materialClaims = new Map(
    currentClaims
      .filter((claim) => claim.kind === "material")
      .map((claim) => [claim.claimId, claim]),
  );
  const unsupportedMaterialClaimIds = params.response.materialClaimIds.filter((claimId) => {
    const claim = materialClaims.get(claimId);
    return (
      !claim ||
      !claim.predicate ||
      claim.value === undefined ||
      !claim.semanticDigest ||
      !claim.evidenceIds?.every((evidenceId) => currentEvidenceIds.has(evidenceId)) ||
      !claim.evidenceIds?.every(
        (evidenceId) =>
          evidence.find((item) => item.evidenceId === evidenceId)?.semanticDigest ===
          claim.semanticDigest,
      )
    );
  });
  if (
    unmetCriteria.length > 0 ||
    semanticFailures.length > 0 ||
    contradictions.length > 0 ||
    reconciliationEffectIds.length > 0 ||
    unverifiedMutationEffectIds.length > 0 ||
    runningActionIds.length > 0 ||
    pendingUserUpdate ||
    unsupportedMaterialClaimIds.length > 0
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
        runningActionIds,
        pendingUserUpdate,
        unsupportedMaterialClaimIds,
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
    executionGeneration: params.task.executionGeneration,
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
