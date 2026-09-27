import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { C02_EFFICIENCY_GUIDANCE, isC02GuidanceEnabled } from "./guidance.js";
import plugin from "./index.js";

const { registerC02Telemetry } = vi.hoisted(() => ({
  registerC02Telemetry: vi.fn(),
}));

vi.mock("./telemetry.js", () => ({ registerC02Telemetry }));

describe("C02 efficiency guidance", () => {
  it("selects an explicit candidate while leaving baseline guidance off", () => {
    expect(isC02GuidanceEnabled(undefined)).toBe(false);
    expect(isC02GuidanceEnabled({ guidanceEnabled: false })).toBe(false);
    expect(isC02GuidanceEnabled({ guidanceEnabled: true })).toBe(true);
  });

  it("registers telemetry and injects guidance for the candidate", async () => {
    const on = vi.fn();
    const api = createTestPluginApi({ on, pluginConfig: { guidanceEnabled: true } });

    plugin.register(api);

    expect(registerC02Telemetry).toHaveBeenCalledWith(api);
    expect(on).toHaveBeenCalledTimes(1);
    const [hookName, handler] = on.mock.calls[0] ?? [];
    expect(hookName).toBe("before_prompt_build");

    expect(await handler({ prompt: "check status", messages: [] }, {})).toEqual({
      prependSystemContext: C02_EFFICIENCY_GUIDANCE,
    });
  });

  it("keeps telemetry registered for the baseline", async () => {
    const on = vi.fn();
    const runtimeConfig = {
      plugins: {
        entries: {
          "refresh-efficiency": { config: { guidanceEnabled: false } },
        },
      },
    };
    const api = createTestPluginApi({
      on,
      pluginConfig: { guidanceEnabled: true },
      runtime: { config: { current: () => runtimeConfig } } as never,
    });

    plugin.register(api);

    expect(registerC02Telemetry).toHaveBeenCalledWith(api);
    const [, handler] = on.mock.calls[0] ?? [];
    expect(await handler({ prompt: "check status", messages: [] }, {})).toBeUndefined();
  });
});
