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

  it("does not invoke a production host factory for an empty module plan", async () => {
    const hostFactory = vi.fn();
    const runtime = createGatewayBehaviorGovernorRuntime({ hostFactory });

    await runtime.apply({ experimental: { behaviorGovernor: { modules: [] } } });
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
