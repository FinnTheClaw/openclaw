import type {
  GatewayBehaviorGovernorModuleActivationContext,
  GatewayBehaviorGovernorModuleFactory,
  GatewayBehaviorGovernorModuleRuntime,
} from "../behavior-governor-module-lifecycle.js";

export const C04B_AGGREGATE_ORDER_MODULE_ID = "C04B.AGGREGATE_ORDER";
export const C04B_AGGREGATE_ORDER_MODULE_VERSION = "1.0.0";
export const C04B_AGGREGATE_ORDER_MODULE_DIGEST =
  "5c6f7135c5d4379950e878c64d2ee1fa49dbff3edfcec8abba6f09e732128830";

export type C04bAggregateOrderActivator = (
  context: GatewayBehaviorGovernorModuleActivationContext,
) => GatewayBehaviorGovernorModuleRuntime | Promise<GatewayBehaviorGovernorModuleRuntime>;

function assertContext(context: GatewayBehaviorGovernorModuleActivationContext): void {
  if (
    context.id !== C04B_AGGREGATE_ORDER_MODULE_ID ||
    context.version !== C04B_AGGREGATE_ORDER_MODULE_VERSION ||
    context.digest !== C04B_AGGREGATE_ORDER_MODULE_DIGEST ||
    (context.mode !== "shadow" && context.mode !== "enforce")
  ) {
    throw new Error("GOVERNOR_C04B_MODULE_CONTEXT_INVALID");
  }
}

/** C04B has no import-time state; lifecycle-owned activation is its only authority. */
export function createC04bAggregateOrderModule(params: {
  activate: C04bAggregateOrderActivator;
}): GatewayBehaviorGovernorModuleFactory {
  return async (context) => {
    assertContext(context);
    const runtime = await params.activate(context);
    if (!runtime || typeof runtime.close !== "function") {
      throw new Error("GOVERNOR_C04B_MODULE_RUNTIME_INVALID");
    }
    return runtime;
  };
}
