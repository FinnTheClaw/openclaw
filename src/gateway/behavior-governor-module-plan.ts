import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";
import {
  createDeepProductiveLoopModule,
  DEEP_PRODUCTIVE_LOOP_MODULE_ID,
  DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
  type DeepProductiveLoopActivator,
} from "./behavior-governor-modules/deep-productive-loop.js";

/**
 * Compiled behavior modules remain inert until the matching id and exact-version
 * selection is present. Deployment verifies the whole frozen artifact SHA-256
 * and records it in its ledger; this runtime never self-attests module code.
 * Factories receive their typed activation context only after selection and
 * return the cleanup handle owned by this lifecycle, never import-time state.
 */
export function createBuiltInBehaviorGovernorModules(params: {
  activateDeepProductiveLoop: DeepProductiveLoopActivator;
}): readonly GatewayBehaviorGovernorModuleDescriptor[] {
  return Object.freeze([
    Object.freeze({
      id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
      version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
      supportedModes: Object.freeze(["shadow", "enforce"] as const),
      qualifiedModes: Object.freeze(["shadow", "enforce"] as const),
      dependencies: Object.freeze([]),
      durableBoundaryIds: Object.freeze([]),
      load: async () =>
        createDeepProductiveLoopModule({ activate: params.activateDeepProductiveLoop }),
    }),
  ] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[]);
}
