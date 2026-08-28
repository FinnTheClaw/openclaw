import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";
import { createProductionGovernorHostFactory } from "./behavior-governor-production-host.js";

/**
 * Compiled behavior modules remain inert until the matching id and exact-version
 * selection is present. Deployment verifies the whole frozen artifact SHA-256
 * and records it in its ledger; this runtime never self-attests module code.
 * Factories receive their typed activation context only after selection and
 * return the cleanup handle owned by this lifecycle, never import-time state.
 * The first skeleton intentionally ships empty.
 */
export const BUILT_IN_BEHAVIOR_GOVERNOR_MODULES = Object.freeze(
  [] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[],
);

/** Production capabilities are compiled beside their declaring descriptor. */
export const BUILT_IN_GOVERNED_RUN_CAPABILITIES = Object.freeze(
  [] satisfies readonly GovernorCapabilityDefinition[],
);

export const createBuiltInProductionGovernorHostFactory = () =>
  createProductionGovernorHostFactory({ capabilityCatalog: BUILT_IN_GOVERNED_RUN_CAPABILITIES });
