import { toAgentRequestSessionKey } from "../routing/session-key.js";
import type { GovernorAgentLoopRunScope } from "../security/governor-agent-loop-readonly.js";
import { parseC02EvaluationSession } from "../security/governor-c02-evaluation.js";
import {
  createC02EvaluationRestartMarkers,
  createGovernorC02EvaluationScope,
} from "../security/governor-c02-local-evaluator.js";
import { createGovernorC02ProductionProfileScope } from "../security/governor-c02-production-profile.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "../security/governor-c02-simple-efficiency-policy.js";
import type { GatewayBehaviorGovernorModuleRunInput } from "./behavior-governor-module-agent-loop.js";
import type {
  GatewayBehaviorGovernorModuleDescriptor,
  GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

export { C02_EVALUATION_SESSION_PREFIX } from "../security/governor-c02-evaluation.js";

// C02 evaluation markers are local to this compiled module; ordinary sessions cannot address them.
const evaluationRestartMarkers = createC02EvaluationRestartMarkers();

const createC02Module: GatewayBehaviorGovernorModuleFactory = (context) => {
  if (context.mode !== "enforce") {
    throw new Error("GOVERNOR_C02_MODE_UNQUALIFIED");
  }
  const scopes = new Set<GovernorAgentLoopRunScope>();
  const activeEvaluations = new Set<string>();
  let closed = false;

  const retain = (scope: GovernorAgentLoopRunScope): GovernorAgentLoopRunScope => {
    scopes.add(scope);
    return scope;
  };

  return Object.freeze({
    agentLoop: Object.freeze({
      resolveRunScope(input: GatewayBehaviorGovernorModuleRunInput) {
        if (closed) {
          throw new Error("GOVERNOR_C02_MODULE_CLOSED");
        }
        const requestSessionKey = toAgentRequestSessionKey(input.run.sessionKey);
        const evaluation = requestSessionKey
          ? parseC02EvaluationSession(requestSessionKey)
          : undefined;
        if (evaluation) {
          const identityReserved = !activeEvaluations.has(evaluation.stableSessionId);
          if (identityReserved) {
            activeEvaluations.add(evaluation.stableSessionId);
          }
          let scope: GovernorAgentLoopRunScope;
          scope = createGovernorC02EvaluationScope({
            run: input.run,
            evaluation,
            restartMarkers: evaluationRestartMarkers,
            identityReserved,
            onDispose() {
              scopes.delete(scope);
              if (identityReserved) {
                activeEvaluations.delete(evaluation.stableSessionId);
              }
            },
          });
          return retain(scope);
        }
        let scope: GovernorAgentLoopRunScope;
        scope = createGovernorC02ProductionProfileScope(input.run, () => {
          scopes.delete(scope);
        });
        return retain(scope);
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
  requiresHost: false,
  supportedModes: Object.freeze(["enforce"] as const),
  qualifiedModes: Object.freeze(["enforce"] as const),
  dependencies: Object.freeze([]),
  durableBoundaryIds: Object.freeze([]),
  load: async () => createC02Module,
}) satisfies GatewayBehaviorGovernorModuleDescriptor;
