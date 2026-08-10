// Classifies work proportionally and creates evidence-bound progress/replan checkpoints.
import type { GovernorMode, GovernorTaskProjection } from "./types.js";

export type GovernorWorkProfile = {
  incident: boolean;
  effectful: boolean;
  requiresExternalEvidence: boolean;
  consequential: boolean;
  estimatedUsefulActions: number;
  independentBranches: number;
};

export type GovernorWorkDecision = {
  mode: GovernorMode;
  requiresContract: boolean;
  requiresPlan: boolean;
  toolPolicy: "forbidden" | "permitted" | "required";
};

export function classifyGovernorWork(profile: GovernorWorkProfile): GovernorWorkDecision {
  if (
    !Number.isSafeInteger(profile.estimatedUsefulActions) ||
    profile.estimatedUsefulActions < 0 ||
    !Number.isSafeInteger(profile.independentBranches) ||
    profile.independentBranches < 0
  ) {
    throw new Error("Governor work estimates must be non-negative safe integers");
  }
  if (profile.incident) {
    return {
      mode: "INCIDENT",
      requiresContract: true,
      requiresPlan: true,
      toolPolicy: profile.effectful || profile.requiresExternalEvidence ? "required" : "permitted",
    };
  }
  const deep = profile.estimatedUsefulActions > 12 || profile.independentBranches > 3;
  if (deep) {
    return {
      mode: "DEEP",
      requiresContract: true,
      requiresPlan: true,
      toolPolicy: profile.effectful || profile.requiresExternalEvidence ? "required" : "permitted",
    };
  }
  if (profile.effectful || profile.requiresExternalEvidence || profile.consequential) {
    return {
      mode: "FOCUSED",
      requiresContract: true,
      requiresPlan: true,
      toolPolicy: profile.effectful || profile.requiresExternalEvidence ? "required" : "permitted",
    };
  }
  return {
    mode: "QUICK",
    requiresContract: false,
    requiresPlan: false,
    toolPolicy: "forbidden",
  };
}

export type GovernorVerifiedCheckpointFact = {
  claim: string;
  evidenceDigest: string;
};

export type GovernorCheckpoint = {
  taskId: string;
  objectiveRevision: number;
  planVersion: number;
  verifiedFacts: readonly GovernorVerifiedCheckpointFact[];
  discardedAssumptions: readonly string[];
  unresolvedQuestions: readonly string[];
  nextDiscriminatingAction: string;
  competingHypotheses: readonly string[];
  createdAt: number;
};

function assertNonEmptyList(values: readonly string[], label: string): void {
  if (values.some((value) => !value.trim())) {
    throw new Error(`${label} must not contain empty values`);
  }
}

export function createGovernorCheckpoint(params: {
  task: GovernorTaskProjection;
  verifiedFacts: readonly GovernorVerifiedCheckpointFact[];
  discardedAssumptions: readonly string[];
  unresolvedQuestions: readonly string[];
  nextDiscriminatingAction: string;
  competingHypotheses?: readonly string[];
  now: number;
}): GovernorCheckpoint {
  assertNonEmptyList(params.discardedAssumptions, "discarded assumptions");
  assertNonEmptyList(params.unresolvedQuestions, "unresolved questions");
  const competingHypotheses = [...(params.competingHypotheses ?? [])];
  assertNonEmptyList(competingHypotheses, "competing hypotheses");
  if (!params.nextDiscriminatingAction.trim()) {
    throw new Error("checkpoint next discriminating action must not be empty");
  }
  for (const fact of params.verifiedFacts) {
    if (!fact.claim.trim() || !/^[a-f0-9]{64}$/u.test(fact.evidenceDigest)) {
      throw new Error("checkpoint verified facts require a claim and evidence digest");
    }
  }
  if (competingHypotheses.length === 1) {
    throw new Error("a replan checkpoint requires at least two competing hypotheses");
  }
  return {
    taskId: params.task.taskId,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    verifiedFacts: structuredClone(params.verifiedFacts),
    discardedAssumptions: [...params.discardedAssumptions],
    unresolvedQuestions: [...params.unresolvedQuestions],
    nextDiscriminatingAction: params.nextDiscriminatingAction.trim(),
    competingHypotheses,
    createdAt: params.now,
  };
}
