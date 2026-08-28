import { installGovernorC05FailureReplan } from "../../security/governor-agent-loop-c05-failure-replan.js";
import type {
  GatewayBehaviorGovernorModuleActivationContext,
  GatewayBehaviorGovernorModuleFactory,
} from "../behavior-governor-module-lifecycle.js";

export const FAILURE_REPLAN_MODULE_ID = "C05.FAILURE_REPLAN";
export const FAILURE_REPLAN_MODULE_VERSION = "1.0.0";

function assertContext(context: GatewayBehaviorGovernorModuleActivationContext): void {
  if (
    context.id !== FAILURE_REPLAN_MODULE_ID ||
    context.version !== FAILURE_REPLAN_MODULE_VERSION ||
    (context.mode !== "shadow" && context.mode !== "enforce")
  ) {
    throw new Error("GOVERNOR_C05_MODULE_CONTEXT_INVALID");
  }
}

/** Import-inert C05 factory; the lifecycle owns the registry cleanup. */
export function createFailureReplanModule(): GatewayBehaviorGovernorModuleFactory {
  return async (context) => {
    assertContext(context);
    return installGovernorC05FailureReplan(context.mode);
  };
}
