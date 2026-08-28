import type { GatewayBehaviorGovernorModuleDescriptor } from "./behavior-governor-module-lifecycle.js";
import {
  createFailureReplanModule,
  FAILURE_REPLAN_MODULE_ID,
  FAILURE_REPLAN_MODULE_VERSION,
} from "./behavior-governor-modules/failure-replan.js";

/** Compiled C05 remains inert until its exact selection passes lifecycle validation. */
export const BUILT_IN_BEHAVIOR_GOVERNOR_MODULES = Object.freeze([
  Object.freeze({
    id: FAILURE_REPLAN_MODULE_ID,
    version: FAILURE_REPLAN_MODULE_VERSION,
    supportedModes: Object.freeze(["shadow", "enforce"] as const),
    qualifiedModes: Object.freeze(["shadow", "enforce"] as const),
    dependencies: Object.freeze([]),
    durableBoundaryIds: Object.freeze(["C05.FAILURE_REPLAN"]),
    load: async () => createFailureReplanModule(),
  }),
] satisfies readonly GatewayBehaviorGovernorModuleDescriptor[]);
