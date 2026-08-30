import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type { GovernorAgentLoopRunScope } from "../security/governor-agent-loop-readonly.js";
import { GOVERNOR_C02_HOST_REGISTRATION } from "../security/governor-c02-runtime-attestation.js";
import {
  C02_CRITERIA_TEMPLATE,
  C02_MAX_TURNS,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "../security/governor-c02-simple-efficiency-policy.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GatewayBehaviorGovernorModuleRunInput } from "./behavior-governor-module-agent-loop.js";
import type {
  GatewayBehaviorGovernorModuleDescriptor,
  GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

const PLAN = Object.freeze({
  schema: "openclaw.governor-c02-module-plan/v1",
  completionVerification: "none",
  maxTurns: C02_MAX_TURNS,
  criteria: C02_CRITERIA_TEMPLATE,
  bindings: Object.freeze([
    Object.freeze({
      toolName: "read",
      capability: "read",
      canonicalTarget: "campaign://c02/observations",
      criterionArgument: "path",
      implementationId: "installed-tool:read",
      criteriaByValue: Object.freeze({
        "/case/alpha.txt": "c02-observe-a",
        "/case/beta.txt": "c02-observe-b",
      }),
    }),
    Object.freeze({
      toolName: "exec",
      capability: "exec",
      canonicalTarget: "campaign://c02/aggregate",
      criterionArgument: "command",
      implementationId: "installed-tool:exec",
      criteriaByValue: Object.freeze({
        "/usr/bin/python3 -c 'print(3)'": "c02-aggregate",
      }),
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
      id: C02_SIMPLE_EFFICIENCY_ID,
      version: C02_SIMPLE_EFFICIENCY_VERSION,
    }),
    hostCapabilities: Object.freeze({
      installedToolInventory: true,
      toolTurnProvenance: true,
    }),
    mode,
    scopes: Object.freeze([Object.freeze({ sessionKey, agentId })]),
    criteria: Object.freeze(
      C02_CRITERIA_TEMPLATE.map((criterion) =>
        Object.freeze({
          criterionId: criterion.criterionId,
          description: `C02 ${criterion.action} criterion`,
          ...(criterion.dependsOn.length
            ? { dependsOnCriteria: Object.freeze([...criterion.dependsOn]) }
            : {}),
        }),
      ),
    ),
    toolBindings: PLAN.bindings,
    maxTurns: C02_MAX_TURNS,
  }) as GovernorAgentLoopConfiguration;
}

const createC02Module: GatewayBehaviorGovernorModuleFactory = (context) => {
  if (context.mode !== "enforce") {
    throw new Error("GOVERNOR_C02_MODE_UNQUALIFIED");
  }
  const mode = context.mode;
  const scopes = new Set<GovernorAgentLoopRunScope>();
  let closed = false;
  return Object.freeze({
    agentLoop: Object.freeze({
      resolveRunScope(input: GatewayBehaviorGovernorModuleRunInput) {
        if (closed) {
          throw new Error("GOVERNOR_C02_MODULE_CLOSED");
        }
        const provider = context.host.agentLoop.createScopeProvider(
          config(mode, input.run.sessionKey, input.run.agentId),
        );
        const binding = provider.createRunBinding({
          run: input.run,
          planDigest: PLAN_DIGEST,
          plan: PLAN,
        });
        let resolved: GovernorAgentLoopRunScope | undefined;
        try {
          resolved = provider.resolveRunScope(input, binding.proof);
          if (!resolved) {
            binding.close();
            provider.close();
            return undefined;
          }
        } catch (error) {
          binding.close();
          provider.close();
          throw error;
        }
        let disposed = false;
        const scope: GovernorAgentLoopRunScope = Object.freeze({
          ...resolved,
          dispose() {
            if (disposed) {
              return;
            }
            disposed = true;
            try {
              resolved!.dispose();
            } finally {
              binding.close();
              provider.close();
              scopes.delete(scope);
            }
          },
        });
        scopes.add(scope);
        return scope;
      },
    }),
    close() {
      if (closed) {
        return;
      }
      const errors: unknown[] = [];
      for (const scope of [...scopes].toReversed()) {
        try {
          scope.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0 || scopes.size > 0) {
        throw new AggregateError(errors, "GOVERNOR_C02_MODULE_CLOSE_FAILED");
      }
      closed = true;
    },
  });
};

export const C02_BEHAVIOR_GOVERNOR_MODULE = Object.freeze({
  id: C02_SIMPLE_EFFICIENCY_ID,
  version: C02_SIMPLE_EFFICIENCY_VERSION,
  supportedModes: Object.freeze(["enforce"] as const),
  qualifiedModes: Object.freeze(["enforce"] as const),
  dependencies: Object.freeze([]),
  durableBoundaryIds: Object.freeze([]),
  hostRegistration: GOVERNOR_C02_HOST_REGISTRATION,
  load: async () => createC02Module,
}) satisfies GatewayBehaviorGovernorModuleDescriptor;
