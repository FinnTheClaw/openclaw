// Builds the durable task update that admits evidence-linked response claims.
import { createGovernorEventRecord, type GovernorEventRecord } from "./events.js";
import {
  createGovernorMaterialClaims,
  type GovernorMaterialClaimInput,
} from "./material-claims.js";
import type { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskProjection } from "./types.js";

export function admitGovernorMaterialClaims(params: {
  store: GovernorSqliteStore;
  task: GovernorTaskProjection;
  claims: readonly GovernorMaterialClaimInput[];
  now: number;
}): { next: GovernorTaskProjection; event: GovernorEventRecord } {
  const claims = createGovernorMaterialClaims({
    task: params.task,
    evidence: params.store.listEvidence(params.task.taskId),
    claims: params.claims,
    now: params.now,
  });
  const next = {
    ...params.task,
    claims: [...params.task.claims, ...claims],
    taskVersion: params.task.taskVersion + 1,
    updatedAt: params.now,
  };
  return {
    next,
    event: createGovernorEventRecord({
      task: next,
      eventType: "material_claims_admitted",
      payload: { claimIds: claims.map((claim) => claim.claimId), count: claims.length },
      now: params.now,
    }),
  };
}
