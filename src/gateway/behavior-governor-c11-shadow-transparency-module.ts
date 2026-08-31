import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { createGatewayBehaviorGovernorModuleGovernedRunConsumer } from "./behavior-governor-module-governed-run.js";
import type {
  GatewayBehaviorGovernorModuleDescriptor,
  GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

export const C11_SHADOW_TRANSPARENCY_ID = "c11-shadow-transparency" as const;
export const C11_SHADOW_TRANSPARENCY_VERSION = "v1" as const;
export const C11_SHADOW_TRANSPARENCY_CAPABILITY = "shadow.observe" as const;

const PLAN = Object.freeze({
  schema: "openclaw.governor-c11-shadow-transparency-plan/v1",
  observation: "private-bounded-hooks-only",
  maxTurns: 256,
  bindings: Object.freeze([
    Object.freeze({
      toolName: "read",
      capability: C11_SHADOW_TRANSPARENCY_CAPABILITY,
      canonicalTarget: "shadow://c11/observation",
      criterionId: "c11-shadow-observation",
      implementationId: "installed-tool:read",
    }),
  ]),
});

const PLAN_DIGEST = governorDigest(PLAN as never);

export function createC11ShadowTransparencyConfiguration(params: {
  sessionKey: string;
  agentId: string;
}): GovernorAgentLoopConfiguration {
  return Object.freeze({
    moduleIdentity: Object.freeze({
      id: C11_SHADOW_TRANSPARENCY_ID,
      version: C11_SHADOW_TRANSPARENCY_VERSION,
    }),
    hostCapabilities: Object.freeze({
      installedToolInventory: true,
      toolTurnProvenance: true,
    }),
    mode: "shadow",
    scopes: Object.freeze([
      Object.freeze({ sessionKey: params.sessionKey, agentId: params.agentId }),
    ]),
    criteria: Object.freeze([
      Object.freeze({
        criterionId: "c11-shadow-observation",
        description: "Private bounded shadow observation",
      }),
    ]),
    toolBindings: PLAN.bindings,
    maxTurns: PLAN.maxTurns,
  }) satisfies GovernorAgentLoopConfiguration;
}

const createC11ShadowTransparencyModule: GatewayBehaviorGovernorModuleFactory = (context) => {
  if (context.mode !== "shadow") {
    throw new Error("GOVERNOR_C11_MODE_UNQUALIFIED");
  }
  return createGatewayBehaviorGovernorModuleGovernedRunConsumer(context, {
    config: (run) =>
      createC11ShadowTransparencyConfiguration({
        sessionKey: run.sessionKey,
        agentId: run.agentId,
      }),
    plan: PLAN,
    planDigest: PLAN_DIGEST,
  });
};

/** Shadow observations are private and cannot alter tools, turns, delivery, or retries. */
export const C11_SHADOW_TRANSPARENCY_BEHAVIOR_GOVERNOR_MODULE = Object.freeze({
  id: C11_SHADOW_TRANSPARENCY_ID,
  version: C11_SHADOW_TRANSPARENCY_VERSION,
  supportedModes: Object.freeze(["shadow"] as const),
  qualifiedModes: Object.freeze(["shadow"] as const),
  dependencies: Object.freeze([]),
  durableBoundaryIds: Object.freeze([]),
  load: async () => createC11ShadowTransparencyModule,
}) satisfies GatewayBehaviorGovernorModuleDescriptor;
