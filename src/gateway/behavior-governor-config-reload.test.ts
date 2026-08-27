import { describe, expect, it } from "vitest";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";

describe("modular behavior governor reload boundary", () => {
  it("requires a gateway restart for module selection changes", () => {
    const path = "experimental.behaviorGovernor.modules";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain(path);
    expect(plan.hotReasons).toStrictEqual([]);
  });
});
