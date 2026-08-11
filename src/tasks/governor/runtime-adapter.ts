import type { GovernorController } from "./controller.js";
import {
  classifyGovernorWork,
  type GovernorWorkDecision,
  type GovernorWorkProfile,
} from "./planning-policy.js";
import type { GovernorTaskContract, GovernorTaskProjection, GovernorTaskScope } from "./types.js";

export type GovernorIngressRoute =
  | { kind: "quick"; decision: GovernorWorkDecision }
  | { kind: "governed"; decision: GovernorWorkDecision; task: GovernorTaskProjection };

export class GovernorRuntimeAdapter {
  constructor(readonly controller: GovernorController) {}

  routeIngress(params: {
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    profile: GovernorWorkProfile;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressRoute {
    const decision = classifyGovernorWork(params.profile);
    if (decision.mode === "QUICK") {
      return { kind: "quick", decision };
    }
    const ingress = this.controller.ingest({
      sourceMessageId: params.sourceMessageId,
      sourceSequence: params.sourceSequence,
      scope: params.scope,
      mode: decision.mode,
      contract: params.contract,
      flowId: params.flowId,
      now: params.now,
    });
    return { kind: "governed", decision, task: ingress.task };
  }
}
