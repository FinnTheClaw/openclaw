import { describe, expect, it } from "vitest";
import type { GatewayBehaviorGovernorPolicy } from "./behavior-governor-lifecycle.js";
import type { ResolvedGatewayBehaviorGovernorModule } from "./behavior-governor-module-lifecycle.js";
import {
  createProductionGovernorHostFactory,
  resolveSelectedGovernorCoreRequirements,
} from "./behavior-governor-production-host.js";

const capability = {
  capability: "fixture.observe",
  version: "1",
  sourceRank: "structured_exact" as const,
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function selected(requires: readonly "governed-run-core"[], capabilities: readonly string[]) {
  return {
    descriptor: {
      id: "C01",
      version: "1.0.0",
      supportedModes: ["shadow"] as const,
      qualifiedModes: ["shadow"] as const,
      dependencies: [],
      durableBoundaryIds: [],
      requires,
      governedRunCapabilities: capabilities,
      load: async () => async () => ({ close: () => {} }),
    },
    selection: { id: "C01", version: "1.0.0", mode: "shadow" as const },
  } satisfies ResolvedGatewayBehaviorGovernorModule;
}

describe("production governed-run host", () => {
  it("resolves only descriptor-declared compiled capabilities", async () => {
    const requirements = resolveSelectedGovernorCoreRequirements([
      selected([], ["ignored.capability"]),
      selected(["governed-run-core"], [capability.capability]),
    ]);
    expect(requirements).toEqual({ capabilities: [capability.capability] });

    const factory = createProductionGovernorHostFactory({ capabilityCatalog: [capability] });
    const host = await factory({
      config: {} as GatewayBehaviorGovernorPolicy,
      stateDir: "/test/state",
      requirements: requirements!,
      secrets: {} as never,
    });
    expect(host).toEqual({ capabilities: [capability] });
    expect("integrations" in host).toBe(false);
  });

  it("fails closed when a selected capability is not compiled", () => {
    const factory = createProductionGovernorHostFactory({ capabilityCatalog: [] });
    expect(() =>
      factory({
        config: {} as GatewayBehaviorGovernorPolicy,
        stateDir: "/test/state",
        requirements: { capabilities: ["unknown.capability"] },
        secrets: {} as never,
      }),
    ).toThrow("GOVERNOR_CORE_CAPABILITY_NOT_COMPILED");
  });
});
