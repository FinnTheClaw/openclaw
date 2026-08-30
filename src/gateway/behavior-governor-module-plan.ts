import { C02_BEHAVIOR_GOVERNOR_MODULE } from "./behavior-governor-c02-module.js";
import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";

/**
 * Compiled behavior modules remain inert until the matching id and exact-version
 * selection is present. Deployment verifies the whole frozen artifact SHA-256
 * and records it in its ledger; this runtime never self-attests module code.
 * Factories receive their typed activation context only after selection and
 * return the cleanup handle owned by this lifecycle, never import-time state.
 * The first skeleton intentionally ships empty.
 */
export const BUILT_IN_BEHAVIOR_GOVERNOR_MODULES = Object.freeze([
  C02_BEHAVIOR_GOVERNOR_MODULE,
] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[]);
