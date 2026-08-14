import type { GovernorPendingEvidence } from "./store-evidence-admission.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorPlan, GovernorTaskProjection } from "./types.js";

export type GovernorPlanReplacement = Readonly<{
  task: GovernorTaskProjection;
  evidenceAdmissions: readonly GovernorPendingEvidence[];
}>;

/** Rebinds still-current evidence to a replacement plan under host control. */
export function prepareGovernorPlanReplacement(params: {
  store: GovernorSqliteStore;
  task: GovernorTaskProjection;
  plan: GovernorPlan;
  now: number;
}): GovernorPlanReplacement {
  const priorEvidence = params.store
    .listEvidence(params.task.taskId)
    .filter(
      (item) =>
        item.objectiveRevision === params.task.objectiveRevision &&
        item.planVersion === params.task.planVersion &&
        item.scopeKey === params.task.scopeKey &&
        item.admissibility === "admitted" &&
        item.invalidatedAt === undefined,
    );
  const nextPlanVersion = params.task.planVersion + 1;
  const replacementBase: GovernorTaskProjection = {
    ...params.task,
    plan: params.plan,
    planVersion: nextPlanVersion,
    taskVersion: params.task.taskVersion + 1,
    updatedAt: params.now + 2,
  };
  const evidenceAdmissions = priorEvidence.map((source) =>
    params.store.carryForwardEvidence({
      source,
      task: replacementBase,
      now: params.now + 2,
    }),
  );
  const carriedBySource = new Map(
    priorEvidence.map((source, index) => [source.evidenceId, evidenceAdmissions[index]!.evidence]),
  );
  return {
    task: {
      ...replacementBase,
      claims: params.task.claims.map((claim) => {
        if (claim.planVersion !== params.task.planVersion) {
          return claim;
        }
        return {
          ...claim,
          planVersion: nextPlanVersion,
          admittedAt: params.now + 2,
          ...(claim.evidenceIds
            ? {
                evidenceIds: claim.evidenceIds.map(
                  (evidenceId) => carriedBySource.get(evidenceId)?.evidenceId ?? evidenceId,
                ),
              }
            : {}),
        };
      }),
    },
    evidenceAdmissions,
  };
}
