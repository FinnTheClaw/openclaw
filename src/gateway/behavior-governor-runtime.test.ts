import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayBehaviorGovernorRuntime } from "./behavior-governor-runtime.js";

const unknownModuleConfig = {
  experimental: {
    behaviorGovernor: {
      modules: [
        {
          id: "C01",
          mode: "shadow",
          version: "1.0.0",
        },
      ],
    },
  },
} satisfies OpenClawConfig;

const c03ModuleWithoutPolicyConfig = {
  experimental: {
    behaviorGovernor: {
      modules: [
        {
          id: "C03.DEEP_PRODUCTIVE_LOOP",
          mode: "shadow",
          version: "1.0.0",
        },
      ],
    },
  },
} satisfies OpenClawConfig;

const unselectedC03PolicyConfig: OpenClawConfig = {
  experimental: {
    behaviorGovernor: {
      enabled: true,
      mode: "enforce",
      secretRefs: {} as never,
      agentLoop: {} as never,
    },
  },
};

describe("gateway behavior governor runtime", () => {
  it.each([
    ["absent", {}],
    ["legacy off", { experimental: { behaviorGovernor: { enabled: false } } }],
    ["empty modules", { experimental: { behaviorGovernor: { modules: [] } } }],
  ] satisfies Array<[string, OpenClawConfig]>)(
    "keeps the %s plan inert without a secret snapshot",
    async (_label, config) => {
      const runtime = createGatewayBehaviorGovernorRuntime({});

      await runtime.apply(config);
      await runtime.freeze();
      await runtime.close();
    },
  );

  it("fails closed when configuration selects a module absent from the artifact", async () => {
    const runtime = createGatewayBehaviorGovernorRuntime({});

    await expect(runtime.apply(unknownModuleConfig)).rejects.toThrow("GOVERNOR_MODULE_UNKNOWN");
  });

  it("recognizes C03 but refuses to activate it without its retained policy", async () => {
    const runtime = createGatewayBehaviorGovernorRuntime({});

    await expect(runtime.apply(c03ModuleWithoutPolicyConfig)).rejects.toThrow(
      "GOVERNOR_C03_CONFIGURATION_REQUIRED",
    );
    await runtime.close();
  });

  it("does not activate legacy C03 policy when its module is unselected", async () => {
    const hostFactory = vi.fn(() => {
      throw new Error("C03 host activation must not run");
    });
    const runtime = createGatewayBehaviorGovernorRuntime({ hostFactory });

    await runtime.apply(unselectedC03PolicyConfig);
    await runtime.freeze();
    await runtime.close();
    expect(hostFactory).not.toHaveBeenCalled();
  });

  it("requires restart after the initial empty plan is fixed", async () => {
    const runtime = createGatewayBehaviorGovernorRuntime({});

    await runtime.apply({});
    await expect(runtime.apply(unknownModuleConfig)).rejects.toThrow(
      "GOVERNOR_MODULE_RESTART_REQUIRED",
    );
    await runtime.close();
  });
});
