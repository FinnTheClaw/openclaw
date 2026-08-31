import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { createGatewayBehaviorGovernorModuleGovernedRunConsumer } from "./behavior-governor-module-governed-run.js";
import type {
  GatewayBehaviorGovernorModuleDescriptor,
  GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

export const C04B_AGGREGATE_ORDER_ID = "c04b-aggregate-order";
export const C04B_AGGREGATE_ORDER_VERSION = "v1";

const PLAN = Object.freeze({
  schema: "openclaw.governor-c04b-aggregate-order-plan/v1",
  completionVerification: "none",
  maxTurns: 8,
  criteria: Object.freeze([
    Object.freeze({ criterionId: "c04b-observe-a", dependsOn: Object.freeze([]) }),
    Object.freeze({
      criterionId: "c04b-observe-b",
      dependsOn: Object.freeze(["c04b-observe-a"]),
    }),
    Object.freeze({
      criterionId: "c04b-observe-c",
      dependsOn: Object.freeze(["c04b-observe-b"]),
    }),
    Object.freeze({
      criterionId: "c04b-aggregate",
      dependsOn: Object.freeze(["c04b-observe-c"]),
    }),
  ]),
  bindings: Object.freeze([
    Object.freeze({
      toolName: "observe",
      capability: "c04b.observe",
      canonicalTarget: "campaign://c04b/observations",
      criterionArgument: "label",
      criteriaByValue: Object.freeze({
        "observe-a": "c04b-observe-a",
        "observe-b": "c04b-observe-b",
        "observe-c": "c04b-observe-c",
      }),
      implementationId: "disposable-observation-v1",
    }),
    Object.freeze({
      toolName: "aggregate",
      capability: "c04b.aggregate",
      canonicalTarget: "campaign://c04b/aggregate",
      criterionId: "c04b-aggregate",
      implementationId: "disposable-aggregate-v1",
    }),
  ]),
});
const PLAN_DIGEST = governorDigest(PLAN as never);

function config(
  mode: "enforce",
  sessionKey: string,
  agentId: string,
): GovernorAgentLoopConfiguration {
  return Object.freeze({
    moduleIdentity: Object.freeze({
      id: C04B_AGGREGATE_ORDER_ID,
      version: C04B_AGGREGATE_ORDER_VERSION,
    }),
    mode,
    scopes: Object.freeze([Object.freeze({ sessionKey, agentId })]),
    criteria: Object.freeze(
      PLAN.criteria.map((criterion) =>
        Object.freeze({
          criterionId: criterion.criterionId,
          description: `C04b ${criterion.criterionId} criterion`,
          ...(criterion.dependsOn.length
            ? { dependsOnCriteria: Object.freeze([...criterion.dependsOn]) }
            : {}),
        }),
      ),
    ),
    toolBindings: PLAN.bindings,
    maxTurns: PLAN.maxTurns,
  }) as GovernorAgentLoopConfiguration;
}

const createC04bModule: GatewayBehaviorGovernorModuleFactory = (context) => {
  if (context.mode !== "enforce") {
    throw new Error("GOVERNOR_C04B_MODE_UNQUALIFIED");
  }
  const mode = context.mode;
  return createGatewayBehaviorGovernorModuleGovernedRunConsumer(context, {
    config: (run) => config(mode, run.sessionKey, run.agentId),
    plan: PLAN,
    planDigest: PLAN_DIGEST,
  });
};

export const C04B_AGGREGATE_ORDER_MODULE = Object.freeze({
  id: C04B_AGGREGATE_ORDER_ID,
  version: C04B_AGGREGATE_ORDER_VERSION,
  supportedModes: Object.freeze(["enforce"] as const),
  qualifiedModes: Object.freeze(["enforce"] as const),
  dependencies: Object.freeze([]),
  durableBoundaryIds: Object.freeze([]),
  load: async () => createC04bModule,
}) satisfies GatewayBehaviorGovernorModuleDescriptor;
