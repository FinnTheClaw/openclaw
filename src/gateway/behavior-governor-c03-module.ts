import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { createGatewayBehaviorGovernorModuleGovernedRunConsumer } from "./behavior-governor-module-governed-run.js";
import type {
  GatewayBehaviorGovernorModuleDescriptor,
  GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

const C03_ID = "c03-deep-productive-loop";
const C03_VERSION = "v1";
const C03_MAX_TURNS = 24;
const OBSERVATION_KEYS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `observe-${String(index + 1).padStart(2, "0")}`),
);
const OBSERVATION_PATHS = Object.freeze(
  Object.fromEntries(OBSERVATION_KEYS.map((key) => [`/case/c03/${key}.txt`, key])),
);
const CRITERIA = Object.freeze([
  ...OBSERVATION_KEYS.map((criterionId, index) =>
    Object.freeze({
      criterionId,
      description: `C03 required observation ${criterionId}`,
      ...(index > 0 ? { dependsOnCriteria: Object.freeze([OBSERVATION_KEYS[index - 1]!]) } : {}),
    }),
  ),
  Object.freeze({
    criterionId: "c03-aggregate",
    description: "C03 aggregate after every required observation",
    dependsOnCriteria: Object.freeze([OBSERVATION_KEYS.at(-1)!]),
  }),
]);
const PLAN = Object.freeze({
  schema: "openclaw.governor-c03-module-plan/v1",
  maxTurns: C03_MAX_TURNS,
  observationKeys: OBSERVATION_KEYS,
  replan: Object.freeze({
    failure: "one-persisted-host-replan",
    guidance: false,
    retry: "same-key",
  }),
  aggregate: Object.freeze({ criterionId: "c03-aggregate", position: "last", count: 1 }),
});
const PLAN_DIGEST = governorDigest(PLAN as never);

function configuration(
  mode: "enforce",
  sessionKey: string,
  agentId: string,
): GovernorAgentLoopConfiguration {
  return Object.freeze({
    moduleIdentity: Object.freeze({ id: C03_ID, version: C03_VERSION }),
    hostCapabilities: Object.freeze({ installedToolInventory: true, toolTurnProvenance: true }),
    mode,
    scopes: Object.freeze([Object.freeze({ sessionKey, agentId })]),
    criteria: CRITERIA,
    toolBindings: Object.freeze([
      Object.freeze({
        toolName: "read",
        capability: "read",
        canonicalTarget: "campaign://c03/observations",
        criterionArgument: "path",
        criteriaByValue: OBSERVATION_PATHS,
        implementationId: "installed-tool:read" as const,
      }),
      Object.freeze({
        toolName: "exec",
        capability: "exec",
        canonicalTarget: "campaign://c03/aggregate",
        criterionId: "c03-aggregate",
        implementationId: "installed-tool:exec" as const,
      }),
    ]),
    maxTurns: C03_MAX_TURNS,
  }) as GovernorAgentLoopConfiguration;
}

const createC03Module: GatewayBehaviorGovernorModuleFactory = (context) => {
  if (context.mode !== "enforce") {
    throw new Error("GOVERNOR_C03_MODE_UNQUALIFIED");
  }
  const mode = context.mode;
  return createGatewayBehaviorGovernorModuleGovernedRunConsumer(context, {
    config: (run) => configuration(mode, run.sessionKey, run.agentId),
    plan: PLAN,
    planDigest: PLAN_DIGEST,
  });
};

/** C03 stays inert until its exact id, version, and enforce selection are present. */
export const C03_BEHAVIOR_GOVERNOR_MODULE = Object.freeze({
  id: C03_ID,
  version: C03_VERSION,
  supportedModes: Object.freeze(["enforce"] as const),
  qualifiedModes: Object.freeze(["enforce"] as const),
  dependencies: Object.freeze([]),
  durableBoundaryIds: Object.freeze([]),
  load: async () => createC03Module,
}) satisfies GatewayBehaviorGovernorModuleDescriptor;
