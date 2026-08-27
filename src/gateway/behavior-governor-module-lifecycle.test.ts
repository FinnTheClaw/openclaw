import { describe, expect, it, vi } from "vitest";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import {
  createGatewayBehaviorGovernorModuleLifecycle,
  type GatewayBehaviorGovernorModuleDescriptor,
  type GatewayBehaviorGovernorModuleFactory,
} from "./behavior-governor-module-lifecycle.js";

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
    const available = descriptor({ id: "C01" });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [available] });

    await lifecycle.apply([]);
    await lifecycle.apply([]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(available.load).not.toHaveBeenCalled();
  });

  it("loads only exact selected modules and preserves their requested mode", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "C01", events });
    const c02 = descriptor({ id: "C02", events });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c01, c02] });

    await lifecycle.apply([selection("C02", "enforce")]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(c01.load).not.toHaveBeenCalled();
    expect(events).toEqual(["load:C02", "start:C02:enforce", "freeze:C02", "close:C02"]);
  });

  it("starts dependencies first and freezes and closes in reverse order", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "C01", events });
    const c02 = descriptor({
      id: "C02",
      dependencies: ["C01"],
      events,
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c02, c01] });

    await lifecycle.apply([selection("C02"), selection("C01")]);
    await lifecycle.freeze();
    await lifecycle.close();

    expect(events).toEqual([
      "load:C01",
      "start:C01:shadow",
      "load:C02",
      "start:C02:shadow",
      "freeze:C02",
      "freeze:C01",
      "close:C02",
      "close:C01",
    ]);
  });

  it.each([
    {
      name: "unsupported enforce mode",
      selection: selection("C01", "enforce"),
      descriptor: descriptor({
        id: "C01",
        supportedModes: ["shadow"],
        qualifiedModes: ["shadow"],
      }),
      code: "GOVERNOR_MODULE_MODE_UNSUPPORTED",
    },
    {
      name: "unqualified shadow mode",
      selection: selection("C01"),
      descriptor: descriptor({
        id: "C01",
        supportedModes: ["shadow"],
        qualifiedModes: [],
      }),
      code: "GOVERNOR_MODULE_MODE_UNQUALIFIED",
    },
  ])(
    "rejects $name before loading code",
    async ({ selection: moduleSelection, descriptor: item, code }) => {
      const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [item] });

      await expect(lifecycle.apply([moduleSelection])).rejects.toThrow(code);
      expect(item.load).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "unknown module",
      catalog: [] as GatewayBehaviorGovernorModuleDescriptor[],
      selections: [selection("C01")],
      code: "GOVERNOR_MODULE_UNKNOWN",
    },
    {
      name: "duplicate selection",
      catalog: [descriptor({ id: "C01" })],
      selections: [selection("C01"), selection("C01")],
      code: "GOVERNOR_MODULE_SELECTION_DUPLICATE",
    },
    {
      name: "version mismatch",
      catalog: [descriptor({ id: "C01", version: "2.0.0" })],
      selections: [selection("C01")],
      code: "GOVERNOR_MODULE_VERSION_MISMATCH",
    },
    {
      name: "missing dependency",
      catalog: [descriptor({ id: "C01", dependencies: ["C02"] })],
      selections: [selection("C01")],
      code: "GOVERNOR_MODULE_DEPENDENCY_MISSING",
    },
    {
      name: "durable boundary conflict",
      catalog: [
        descriptor({ id: "C01", durableBoundaryIds: ["TASK-STATE"] }),
        descriptor({
          id: "C02",
          durableBoundaryIds: ["TASK-STATE"],
        }),
      ],
      selections: [selection("C01"), selection("C02")],
      code: "GOVERNOR_MODULE_BOUNDARY_CONFLICT",
    },
    {
      name: "dependency cycle",
      catalog: [
        descriptor({ id: "C01", dependencies: ["C02"] }),
        descriptor({ id: "C02", dependencies: ["C01"] }),
      ],
      selections: [selection("C01"), selection("C02")],
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
    const c01 = descriptor({ id: "C01" });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c01] });

    await lifecycle.apply([]);
    await expect(lifecycle.apply([selection("C01")])).rejects.toThrow(
      "GOVERNOR_MODULE_RESTART_REQUIRED",
    );
    expect(c01.load).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("rolls back already-started modules when a later factory fails", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "C01", events });
    const c02 = descriptor({
      id: "C02",
      dependencies: ["C01"],
      events,
      failStart: true,
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c01, c02] });

    await expect(lifecycle.apply([selection("C01"), selection("C02")])).rejects.toThrow(
      "start failed: C02",
    );
    expect(events).toEqual([
      "load:C01",
      "start:C01:shadow",
      "load:C02",
      "start:C02:shadow",
      "close:C01",
    ]);
  });

  it.each([
    { name: "factory", failStart: true, expectedEvent: "start:C03:shadow" },
    { name: "load", failLoad: true, expectedEvent: "load:C03" },
  ])("poisons after a later $name failure retains only unclosed runtimes", async (failure) => {
    const events: string[] = [];
    const c01 = descriptor({ id: "C01", events });
    const c02 = descriptor({ id: "C02", events, closeFailures: 1 });
    const c03 = descriptor({ id: "C03", events, ...failure });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c01, c02, c03] });

    await expect(
      lifecycle.apply([selection("C01"), selection("C02"), selection("C03")]),
    ).rejects.toThrow("GOVERNOR_MODULE_STARTUP_CLEANUP_FAILED");
    await expect(lifecycle.apply([selection("C01")])).rejects.toThrow(
      "GOVERNOR_MODULE_LIFECYCLE_POISONED",
    );
    await lifecycle.close();

    expect(events.filter((event) => event === "close:C01")).toHaveLength(1);
    expect(events.filter((event) => event === "close:C02")).toHaveLength(2);
    expect(events).toContain(failure.expectedEvent);
  });

  it("retries only runtimes whose prior gateway close failed", async () => {
    const events: string[] = [];
    const c01 = descriptor({ id: "C01", events });
    const c02 = descriptor({ id: "C02", events, closeFailures: 1 });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({ catalog: [c01, c02] });

    await lifecycle.apply([selection("C01"), selection("C02")]);
    await expect(lifecycle.close()).rejects.toThrow("GOVERNOR_MODULE_CLOSE_FAILED");
    await lifecycle.close();

    expect(events.filter((event) => event === "close:C01")).toHaveLength(1);
    expect(events.filter((event) => event === "close:C02")).toHaveLength(2);
  });
});
