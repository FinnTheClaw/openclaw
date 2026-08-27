import type {
  GatewayBehaviorGovernorModuleActivationContext,
  GatewayBehaviorGovernorModuleFactory,
  GatewayBehaviorGovernorModuleRuntime,
} from "../behavior-governor-module-lifecycle.js";

export const DEEP_PRODUCTIVE_LOOP_MODULE_ID = "C03.DEEP_PRODUCTIVE_LOOP";
export const DEEP_PRODUCTIVE_LOOP_MODULE_VERSION = "1.0.0";

export type DeepProductiveLoopActivator = (
  context: GatewayBehaviorGovernorModuleActivationContext,
) => GatewayBehaviorGovernorModuleRuntime | Promise<GatewayBehaviorGovernorModuleRuntime>;

function assertDeepProductiveLoopContext(
  context: GatewayBehaviorGovernorModuleActivationContext,
): void {
  if (
    context.id !== DEEP_PRODUCTIVE_LOOP_MODULE_ID ||
    context.version !== DEEP_PRODUCTIVE_LOOP_MODULE_VERSION ||
    (context.mode !== "shadow" && context.mode !== "enforce")
  ) {
    throw new Error("GOVERNOR_C03_MODULE_CONTEXT_INVALID");
  }
}

/**
 * C03 owns no import-time state. Its host activation is supplied by the
 * gateway, and the returned runtime is closed by the module lifecycle.
 */
export function createDeepProductiveLoopModule(params: {
  activate: DeepProductiveLoopActivator;
}): GatewayBehaviorGovernorModuleFactory {
  return async (context) => {
    assertDeepProductiveLoopContext(context);
    const runtime = await params.activate(context);
    if (!runtime || typeof runtime.close !== "function") {
      throw new Error("GOVERNOR_C03_MODULE_RUNTIME_INVALID");
    }
    return runtime;
  };
}
