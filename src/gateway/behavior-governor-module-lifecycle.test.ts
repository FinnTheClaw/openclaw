import { describe, expect, it, vi } from "vitest";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import {
  createGatewayBehaviorGovernorModuleLifecycle,
  type GatewayBehaviorGovernorModuleDescriptor,
  type GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

const TEST_HOST_PROVIDER = {
  acquire: vi.fn(async () => ({
    capability: {
      forActivation: () => ({
        agentLoop: {
          createScopeProvider: () => {
            throw new Error("TEST_SCOPE_PROVIDER_UNUSED");
          },
          createRunBinding: () => {
            throw new Error("TEST_RUN_BINDING_UNUSED");
          },
        },
      }),
    },
    freeze: vi.fn(),
    close: vi.fn(),
  })),
};

function selection(
  id: string,
  mode: BehaviorGovernorModuleSelection["mode"] = "shadow",
  version = "1.0.0",
): BehaviorGovernorModuleSelection {
  return { id, mode, version };
}

function descriptor(params: {
  id: string;
  version?: string;
  supportedModes?: readonly BehaviorGovernorModuleSelection["mode"][];
  qualifiedModes?: readonly BehaviorGovernorModuleSelection["mode"][];
  dependencies?: readonly string[];
  durableBoundaryIds?: readonly string[];
  events?: string[];
  failStart?: boolean;
  failLoad?: boolean;
  closeFailures?: number;
}): GatewayBehaviorGovernorModuleDescriptor {
  let closeFailures = params.closeFailures ?? 0;
  return {
    id: params.id,
    version: params.version ?? "1.0.0",
    supportedModes: params.supportedModes ?? ["shadow", "enforce"],
    qualifiedModes: params.qualifiedModes ?? ["shadow", "enforce"],
    dependencies: params.dependencies ?? [],
    durableBoundaryIds: params.durableBoundaryIds ?? [],
    load: vi.fn(async (): Promise<GatewayBehaviorGovernorModuleFactory> => {
      params.events?.push(`load:${params.id}`);
      if (params.failLoad) {
        throw new Error(`load failed: ${params.id}`);
      }
      return async (input) => {
        params.events?.push(`start:${input.id}:${input.mode}`);
        if (params.failStart) {
          throw new Error(`start failed: ${params.id}`);
        }
        return {
          freeze: () => {
            params.events?.push(`freeze:${params.id}`);
          },
          close: () => {
            params.events?.push(`close:${params.id}`);
            if (closeFailures > 0) {
              closeFailures -= 1;
              throw new Error(`close failed: ${params.id}`);
            }
          },
        };
      };
    }),
  };
}

describe("gateway behavior governor module lifecycle", () => {
  it("keeps an empty plan inert even when compiled modules are available", async () => {
    const available = descriptor({ id: "c01" });
    const acquire = vi.fn(TEST_HOST_PROVIDER.acquire);
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: { acquire },
      catalog: [available],
    });

    await lifecycle.apply([]);
    await lifecycle.apply([]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(available.load).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("runs the exact lowercase module selection accepted by persisted config", async () => {
    const item = descriptor({ id: "c02.deep-loop" });
    const parsed = OpenClawSchema.parse({
      experimental: {
        behaviorGovernor: {
          modules: [{ id: "c02.deep-loop", mode: "enforce", version: "1.0.0" }],
        },
      },
    });
    const configured = parsed.experimental?.behaviorGovernor;
    if (!configured || !("modules" in configured)) {
      throw new Error("expected parsed modular configuration");
    }
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [item],
    });

    await lifecycle.apply(configured.modules);

    expect(item.load).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("acquires one host after validation and releases it after modules", async () => {
    const events: string[] = [];
    const gatewayConfig = { gateway: { mode: "local" } } as const;
    const acquire = vi.fn(async (input: unknown) => {
      events.push("acquire:host");
      expect(input).toEqual({ gatewayConfig });
      return {
        capability: {
          forActivation: () => ({
            agentLoop: {
              createScopeProvider: () => {
                throw new Error("TEST_SCOPE_PROVIDER_UNUSED");
              },
              createRunBinding: () => {
                throw new Error("TEST_RUN_BINDING_UNUSED");
              },
            },
          }),
        },
        freeze: () => {
          events.push("freeze:host");
        },
        close: () => {
          events.push("close:host");
        },
      };
    });
    const item = descriptor({ id: "c01", events });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: { acquire },
      catalog: [item],
    });

    await lifecycle.apply([selection("c01")], gatewayConfig);
    await lifecycle.apply([selection("c01")], gatewayConfig);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(acquire).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "acquire:host",
      "load:c01",
      "start:c01:shadow",
      "freeze:c01",
      "freeze:host",
      "close:c01",
      "close:host",
    ]);
  });

  it("loads only exact selected modules and preserves their requested mode", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "c01", events });
    const c02 = descriptor({ id: "c02", events });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c01, c02],
    });

    await lifecycle.apply([selection("c02", "enforce")]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(c01.load).not.toHaveBeenCalled();
    expect(events).toEqual(["load:c02", "start:c02:enforce", "freeze:c02", "close:c02"]);
  });

  it("starts dependencies first and freezes and closes in reverse order", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "c01", events });
    const c02 = descriptor({
      id: "c02",
      dependencies: ["c01"],
      events,
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c02, c01],
    });

    await lifecycle.apply([selection("c02"), selection("c01")]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(events).toEqual([
      "load:c01",
      "start:c01:shadow",
      "load:c02",
      "start:c02:shadow",
      "freeze:c02",
      "freeze:c01",
      "close:c02",
      "close:c01",
    ]);
  });

  it.each([
    {
      name: "unsupported enforce mode",
      selection: selection("c01", "enforce"),
      descriptor: descriptor({
        id: "c01",
        supportedModes: ["shadow"],
        qualifiedModes: ["shadow"],
      }),
      code: "GOVERNOR_MODULE_MODE_UNSUPPORTED",
    },
    {
      name: "unqualified shadow mode",
      selection: selection("c01"),
      descriptor: descriptor({
        id: "c01",
        supportedModes: ["shadow"],
        qualifiedModes: [],
      }),
      code: "GOVERNOR_MODULE_MODE_UNQUALIFIED",
    },
  ])(
    "rejects $name before loading code",
    async ({ selection: moduleSelection, descriptor: item, code }) => {
      const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
        hostProvider: TEST_HOST_PROVIDER,
        catalog: [item],
      });

      await expect(lifecycle.apply([moduleSelection])).rejects.toThrow(code);
      expect(item.load).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "unknown module",
      catalog: [] as GatewayBehaviorGovernorModuleDescriptor[],
      selections: [selection("c01")],
      code: "GOVERNOR_MODULE_UNKNOWN",
    },
    {
      name: "duplicate selection",
      catalog: [descriptor({ id: "c01" })],
      selections: [selection("c01"), selection("c01")],
      code: "GOVERNOR_MODULE_SELECTION_DUPLICATE",
    },
    {
      name: "version mismatch",
      catalog: [descriptor({ id: "c01", version: "2.0.0" })],
      selections: [selection("c01")],
      code: "GOVERNOR_MODULE_VERSION_MISMATCH",
    },
    {
      name: "missing dependency",
      catalog: [descriptor({ id: "c01", dependencies: ["c02"] })],
      selections: [selection("c01")],
      code: "GOVERNOR_MODULE_DEPENDENCY_MISSING",
    },
    {
      name: "durable boundary conflict",
      catalog: [
        descriptor({ id: "c01", durableBoundaryIds: ["TASK-STATE"] }),
        descriptor({
          id: "c02",
          durableBoundaryIds: ["TASK-STATE"],
        }),
      ],
      selections: [selection("c01"), selection("c02")],
      code: "GOVERNOR_MODULE_BOUNDARY_CONFLICT",
    },
    {
      name: "dependency cycle",
      catalog: [
        descriptor({ id: "c01", dependencies: ["c02"] }),
        descriptor({ id: "c02", dependencies: ["c01"] }),
      ],
      selections: [selection("c01"), selection("c02")],
      code: "GOVERNOR_MODULE_DEPENDENCY_CYCLE",
    },
  ])("rejects $name before loading code", async ({ catalog, selections, code }) => {
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog });

    await expect(lifecycle.apply(selections)).rejects.toThrow(code);
    for (const item of catalog) {
      expect(item.load).not.toHaveBeenCalled();
    }
  });

  it("requires a restart for a changed selection after the initial plan", async () => {
    const c01 = descriptor({ id: "c01" });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c01],
    });

    await lifecycle.apply([]);
    await expect(lifecycle.apply([selection("c01")])).rejects.toThrow(
      "GOVERNOR_MODULE_RESTART_REQUIRED",
    );
    expect(c01.load).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("rolls back already-started modules when a later factory fails", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "c01", events });
    const c02 = descriptor({
      id: "c02",
      dependencies: ["c01"],
      events,
      failStart: true,
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c01, c02],
    });

    await expect(lifecycle.apply([selection("c01"), selection("c02")])).rejects.toThrow(
      "start failed: c02",
    );
    expect(events).toEqual([
      "load:c01",
      "start:c01:shadow",
      "load:c02",
      "start:c02:shadow",
      "close:c01",
    ]);
  });

  it("retains an acquired host whose startup rollback close failed", async () => {
    let failures = 1;
    const close = vi.fn(() => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("host close failed");
      }
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: {
        acquire: async () => ({
          capability: (await TEST_HOST_PROVIDER.acquire()).capability,
          freeze: vi.fn(),
          close,
        }),
      },
      catalog: [descriptor({ id: "c01", failStart: true })],
    });

    await expect(lifecycle.apply([selection("c01")])).rejects.toThrow(
      "GOVERNOR_MODULE_STARTUP_CLEANUP_FAILED",
    );
    expect(close).toHaveBeenCalledOnce();
    await lifecycle.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "factory", failStart: true, expectedEvent: "start:c03:shadow" },
    { name: "load", failLoad: true, expectedEvent: "load:c03" },
  ])("poisons after a later $name failure retains only unclosed runtimes", async (failure) => {
    const events: string[] = [];
    const c01 = descriptor({ id: "c01", events });
    const c02 = descriptor({ id: "c02", events, closeFailures: 1 });
    const c03 = descriptor({ id: "c03", events, ...failure });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c01, c02, c03],
    });

    await expect(
      lifecycle.apply([selection("c01"), selection("c02"), selection("c03")]),
    ).rejects.toThrow("GOVERNOR_MODULE_STARTUP_CLEANUP_FAILED");
    await expect(lifecycle.apply([selection("c01")])).rejects.toThrow(
      "GOVERNOR_MODULE_LIFECYCLE_POISONED",
    );
    await lifecycle.close();

    expect(events.filter((event) => event === "close:c01")).toHaveLength(1);
    expect(events.filter((event) => event === "close:c02")).toHaveLength(2);
    expect(events).toContain(failure.expectedEvent);
  });

  it("retries only runtimes whose prior gateway close failed", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "c01", events });
    const c02 = descriptor({ id: "c02", events, closeFailures: 1 });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [c01, c02],
    });

    await lifecycle.apply([selection("c01"), selection("c02")]);
    await expect(lifecycle.close()).rejects.toThrow("GOVERNOR_MODULE_CLOSE_FAILED");
    await lifecycle.close();

    expect(events.filter((event) => event === "close:c01")).toHaveLength(1);
    expect(events.filter((event) => event === "close:c02")).toHaveLength(2);
  });

  it("does not acquire a generic host for a selected hostless module", async () => {
    const acquire = vi.fn(async () => {
      throw new Error("host must remain unacquired");
    });
    const factory = vi.fn(async (input: Parameters<GatewayBehaviorGovernorModuleFactory>[0]) => {
      expect(input.host).toBeUndefined();
      return { close: vi.fn() };
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: { acquire },
      catalog: [
        {
          id: "c02",
          version: "1.0.0",
          requiresHost: false,
          supportedModes: ["shadow"],
          qualifiedModes: ["shadow"],
          dependencies: [],
          durableBoundaryIds: [],
          load: vi.fn(async () => factory),
        },
      ],
    });

    await lifecycle.apply([selection("c02")]);
    expect(acquire).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
    await lifecycle.close();
  });
});
