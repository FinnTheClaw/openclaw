import { installAtomicFinalResponsePolicy } from "../../agents/embedded-agent-runner/atomic-final-response-policy.js";
import type {
  GatewayBehaviorGovernorModuleActivationContext,
  GatewayBehaviorGovernorModuleFactory,
} from "../behavior-governor-module-lifecycle.js";

export const C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID = "C06B.FINAL-RESPONSE";
export const C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION = "1.0.0";

function assertContext(context: GatewayBehaviorGovernorModuleActivationContext): void {
  if (
    context.id !== C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID ||
    context.version !== C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION ||
    (context.mode !== "shadow" && context.mode !== "enforce")
  ) {
    throw new Error("GOVERNOR_C06B_MODULE_CONTEXT_INVALID");
  }
}

/** Import-inert C06b factory; the lifecycle owns registry cleanup. */
export function createC06bAtomicFinalResponseModule(): GatewayBehaviorGovernorModuleFactory {
  return (context) => {
    assertContext(context);
    return installAtomicFinalResponsePolicy(context.mode);
  };
}
