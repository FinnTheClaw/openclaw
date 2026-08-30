import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";
import {
  C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
  C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION,
  createC06bAtomicFinalResponseModule,
} from "./behavior-governor-modules/c06b-atomic-final-response.js";

/**
 * Compiled behavior modules remain inert until the matching id and exact-version
 * selection is present. Deployment verifies the whole frozen artifact SHA-256
 * and records it in its ledger; this runtime never self-attests module code.
 * Factories receive their typed activation context only after selection and
 * return the cleanup handle owned by this lifecycle, never import-time state.
 * The first skeleton intentionally ships empty.
 */
export const BUILT_IN_BEHAVIOR_GOVERNOR_MODULES = Object.freeze([
  Object.freeze({
    id: C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
    version: C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION,
    supportedModes: Object.freeze(["shadow", "enforce"] as const),
    qualifiedModes: Object.freeze(["shadow", "enforce"] as const),
    dependencies: Object.freeze([]),
    durableBoundaryIds: Object.freeze([]),
    load: async () => createC06bAtomicFinalResponseModule(),
  }),
] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[]);
