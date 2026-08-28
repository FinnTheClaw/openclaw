import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";
import {
  createC04bAggregateOrderModule,
  C04B_AGGREGATE_ORDER_MODULE_DIGEST,
  C04B_AGGREGATE_ORDER_MODULE_ID,
  C04B_AGGREGATE_ORDER_MODULE_VERSION,
  type C04bAggregateOrderActivator,
} from "./behavior-governor-modules/c04b-aggregate-order.js";

/**
 * Compiled behavior modules remain inert until the matching id and exact-version
 * selection is present. Deployment verifies the whole frozen artifact SHA-256
 * and records it in its ledger; this runtime never self-attests module code.
 * Factories receive their typed activation context only after selection and
 * return the cleanup handle owned by this lifecycle, never import-time state.
 * The first skeleton intentionally ships empty.
 */
export function createBuiltInBehaviorGovernorModules(params: {
  activateC04bAggregateOrder: C04bAggregateOrderActivator;
}): readonly GatewayBehaviorGovernorModuleDescriptor[] {
  return Object.freeze([
    Object.freeze({
      digest: C04B_AGGREGATE_ORDER_MODULE_DIGEST,
      id: C04B_AGGREGATE_ORDER_MODULE_ID,
      version: C04B_AGGREGATE_ORDER_MODULE_VERSION,
      supportedModes: Object.freeze(["shadow", "enforce"] as const),
      qualifiedModes: Object.freeze(["shadow", "enforce"] as const),
      dependencies: Object.freeze([]),
      durableBoundaryIds: Object.freeze(["C04B.AGGREGATE.ORDER"]),
      load: async () =>
        createC04bAggregateOrderModule({ activate: params.activateC04bAggregateOrder }),
    }),
  ] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[]);
}
