import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

describe("frozen native tool-loop detection defaults", () => {
  it.each([
    ["no config", undefined],
    ["empty config", {}],
    ["empty global setting", { tools: { loopDetection: {} } }],
    ["explicit global enable", { tools: { loopDetection: { enabled: true } } }],
  ])("enables both guards for %s", (_label, cfg) => {
    expect(resolveToolLoopDetectionConfig({ cfg: cfg as OpenClawConfig | undefined })).toEqual({
      enabled: true,
    });
  });

  it("preserves explicit global opt-out", () => {
    expect(
      resolveToolLoopDetectionConfig({
        cfg: { tools: { loopDetection: { enabled: false } } },
      }),
    ).toEqual({ enabled: false });
  });

  it.each([
    [true, false, false],
    [false, true, true],
    [false, undefined, false],
    [undefined, undefined, true],
  ])("resolves global %s and agent %s to %s", (global, agent, expected) => {
    const cfg = {
      tools: { loopDetection: { enabled: global } },
      agents: { entries: { finn: { tools: { loopDetection: { enabled: agent } } } } },
    } as OpenClawConfig;
    expect(resolveToolLoopDetectionConfig({ cfg, agentId: "finn" })).toEqual({ enabled: expected });
  });
});
