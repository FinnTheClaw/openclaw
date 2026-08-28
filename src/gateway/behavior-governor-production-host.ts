import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GatewayBehaviorGovernorHostFactory } from "./behavior-governor-lifecycle.js";
import type { ResolvedGatewayBehaviorGovernorModule } from "./behavior-governor-module-lifecycle.js";

export type SelectedGovernorCoreRequirements = Readonly<{
  capabilities: readonly string[];
}>;

/** Resolves only compiled descriptor declarations; config never contributes IDs. */
export function resolveSelectedGovernorCoreRequirements(
  modules: readonly ResolvedGatewayBehaviorGovernorModule[],
): SelectedGovernorCoreRequirements | undefined {
  const selected = modules.filter((module) =>
    module.descriptor.requires.includes("governed-run-core"),
  );
  if (selected.length === 0) {
    return undefined;
  }
  return Object.freeze({
    capabilities: Object.freeze(
      [
        ...new Set(selected.flatMap((module) => module.descriptor.governedRunCapabilities)),
      ].toSorted(),
    ),
  });
}

/**
 * The only production host factory. It exposes compiled read-only capabilities
 * and deliberately has no channel, owner-ingress, or delivery integration.
 */
export function createProductionGovernorHostFactory(params: {
  capabilityCatalog: readonly GovernorCapabilityDefinition[];
}): GatewayBehaviorGovernorHostFactory {
  const catalog = new Map(
    params.capabilityCatalog.map((capability) => [capability.capability, capability]),
  );
  return ({ requirements }) => {
    const capabilities = requirements.capabilities.map((id) => {
      const capability = catalog.get(id);
      if (!capability) {
        throw new Error("GOVERNOR_CORE_CAPABILITY_NOT_COMPILED");
      }
      return capability;
    });
    return Object.freeze({ capabilities: Object.freeze(capabilities) });
  };
}
