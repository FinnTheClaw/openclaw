import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayBehaviorGovernorLifecycle } from "../behavior-governor-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "../behavior-governor-module-lifecycle.js";
import { createDeepProductiveLoopActivator } from "./deep-productive-loop-activation.js";
import { createDeepProductiveLoopModule } from "./deep-productive-loop.js";

const config = {
  experimental: {
    behaviorGovernor: {
      enabled: true,
      mode: "enforce",
      secretRefs: {},
      agentLoop: {},
    },
  },
} as unknown as OpenClawConfig;

const snapshot = {
  env: {},
  generation: "snapshot-generation",
  sourceConfig: config.experimental?.behaviorGovernor,
  config: { secretRefs: { receiptSigningKey: "test-signing-key" } },
} as never;

function harness(overrides: Record<string, unknown> = {}) {
  const lifecycle: GatewayBehaviorGovernorLifecycle = {
    apply: vi.fn(async () => undefined),
    freeze: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const services = {
    clearSigner: vi.fn(),
    createLifecycle: vi.fn(() => lifecycle),
    fenceReceipts: vi.fn(),
    getGeneration: vi.fn(() => "receipt-generation"),
    getSnapshot: vi.fn(() => snapshot),
    installSigner: vi.fn(),
    ...overrides,
  };
  const activate = createDeepProductiveLoopActivator({
    getConfig: () => config,
    hostFactory: vi.fn() as never,
    services,
  });
  return { activate, lifecycle, services };
}

describe("deep productive loop transactional activation", () => {
  it("prepares signer and fence before activating the legacy owner", async () => {
    const order: string[] = [];
    const { activate, lifecycle, services } = harness({
      installSigner: vi.fn(() => order.push("signer")),
      fenceReceipts: vi.fn(() => order.push("fence")),
    });
    vi.mocked(lifecycle.apply).mockImplementation(async () => {
      order.push("apply");
    });

    const runtime = await activate({
      id: "C03.DEEP_PRODUCTIVE_LOOP",
      version: "1.0.0",
      mode: "enforce",
    });
    await runtime.freeze?.();
    await runtime.close();

    expect(order).toEqual(["signer", "fence", "apply"]);
    expect(lifecycle.freeze).toHaveBeenCalledOnce();
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(services.clearSigner).toHaveBeenCalledOnce();
  });

  it.each(["signer", "fence", "apply"] as const)(
    "rolls back completely when %s setup fails",
    async (failure) => {
      const { activate, lifecycle, services } = harness();
      if (failure === "signer") {
        vi.mocked(services.installSigner).mockImplementation(() => {
          throw new Error("signer failed");
        });
      } else if (failure === "fence") {
        vi.mocked(services.fenceReceipts).mockImplementation(() => {
          throw new Error("fence failed");
        });
      } else {
        vi.mocked(lifecycle.apply).mockRejectedValue(new Error("apply failed"));
      }

      await expect(
        activate({ id: "C03.DEEP_PRODUCTIVE_LOOP", version: "1.0.0", mode: "enforce" }),
      ).rejects.toThrow(`${failure} failed`);
      expect(lifecycle.close).toHaveBeenCalledOnce();
      expect(services.clearSigner).toHaveBeenCalledOnce();
      expect(lifecycle.apply).toHaveBeenCalledTimes(failure === "apply" ? 1 : 0);
    },
  );

  it("lets the skeleton retry only incomplete close work", async () => {
    const { activate, lifecycle, services } = harness();
    vi.mocked(lifecycle.close)
      .mockRejectedValueOnce(new Error("host close failed"))
      .mockResolvedValueOnce(undefined);
    const modules = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: [
        {
          id: "C03.DEEP_PRODUCTIVE_LOOP",
          version: "1.0.0",
          supportedModes: ["shadow", "enforce"],
          qualifiedModes: ["shadow", "enforce"],
          dependencies: [],
          durableBoundaryIds: [],
          load: async () => createDeepProductiveLoopModule({ activate }),
        },
      ],
    });
    await modules.apply([{ id: "C03.DEEP_PRODUCTIVE_LOOP", version: "1.0.0", mode: "enforce" }]);

    await expect(modules.close()).rejects.toThrow("GOVERNOR_MODULE_CLOSE_FAILED");
    await modules.close();

    expect(lifecycle.close).toHaveBeenCalledTimes(2);
    expect(services.clearSigner).toHaveBeenCalledOnce();
  });

  it("retries signer cleanup without closing the host twice", async () => {
    const { activate, lifecycle, services } = harness();
    vi.mocked(services.clearSigner)
      .mockImplementationOnce(() => {
        throw new Error("clear failed");
      })
      .mockImplementationOnce(() => undefined);
    const runtime = await activate({
      id: "C03.DEEP_PRODUCTIVE_LOOP",
      version: "1.0.0",
      mode: "enforce",
    });

    await expect(runtime.close()).rejects.toThrow("GOVERNOR_C03_CLOSE_FAILED");
    await runtime.close();

    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(services.clearSigner).toHaveBeenCalledTimes(2);
  });
});
