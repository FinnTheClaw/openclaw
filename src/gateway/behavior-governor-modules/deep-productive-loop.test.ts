import { describe, expect, it, vi } from "vitest";
import { createGatewayBehaviorGovernorModuleLifecycle } from "../behavior-governor-module-lifecycle.js";
import { createBuiltInBehaviorGovernorModules } from "../behavior-governor-module-plan.js";
import {
  createDeepProductiveLoopModule,
  DEEP_PRODUCTIVE_LOOP_MODULE_ID,
  DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
} from "./deep-productive-loop.js";

describe("C03 deep productive loop module", () => {
  it("keeps C03 inactive by default and starts only the exact selected module", async () => {
    const close = vi.fn();
    const activate = vi.fn(async () => ({ close }));
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({ activateDeepProductiveLoop: activate }),
    });

    await lifecycle.apply([]);
    expect(activate).not.toHaveBeenCalled();
    await lifecycle.close();

    const selected = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({ activateDeepProductiveLoop: activate }),
    });
    await selected.apply([
      {
        id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
        mode: "shadow",
        version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
      },
    ]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenLastCalledWith({
      id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
      mode: "shadow",
      version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
    });
    await selected.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not activate until the exact selected context reaches its factory", async () => {
    const activate = vi.fn(async () => ({ close: vi.fn() }));
    const factory = createDeepProductiveLoopModule({ activate });

    expect(activate).not.toHaveBeenCalled();
    const runtime = await factory({
      id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
      mode: "enforce",
      version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
    });

    expect(activate).toHaveBeenCalledWith({
      id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
      mode: "enforce",
      version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
    });
    expect(typeof runtime.close).toBe("function");
  });

  it("rejects a mismatched identity before invoking the host activator", async () => {
    const activate = vi.fn(async () => ({ close: vi.fn() }));
    const factory = createDeepProductiveLoopModule({ activate });

    await expect(
      factory({
        id: "C04B.AGGREGATE_ORDER",
        mode: "shadow",
        version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
      }),
    ).rejects.toThrow("GOVERNOR_C03_MODULE_CONTEXT_INVALID");
    expect(activate).not.toHaveBeenCalled();
  });

  it("requires the activator to return a lifecycle-owned cleanup handle", async () => {
    const factory = createDeepProductiveLoopModule({
      activate: async () => ({}) as never,
    });

    await expect(
      factory({
        id: DEEP_PRODUCTIVE_LOOP_MODULE_ID,
        mode: "shadow",
        version: DEEP_PRODUCTIVE_LOOP_MODULE_VERSION,
      }),
    ).rejects.toThrow("GOVERNOR_C03_MODULE_RUNTIME_INVALID");
  });
});
