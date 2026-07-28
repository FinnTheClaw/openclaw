// Subagents tool tests cover owner-scoped live control guidance and numeric
// status-window validation.
import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    // sessions_yield is context-dependent; the model-facing description should
    // not promise it exists in every runtime.
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "List, kill, or live-steer spawned subagents owned by this requester session. If sessions_yield exists, use it for completion; do not poll wait loops.",
    );
  });

  it.each(["kill", "steer"])("requires an explicit target for %s", async (action) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-control", {
        action,
        ...(action === "steer" ? { message: "Use the existing evidence and finish." } : {}),
      }),
    ).rejects.toThrow("target");
  });

  it.each([0, 1.5])("rejects invalid recentMinutes value %s", async (recentMinutes) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-1", {
        action: "list",
        recentMinutes,
      }),
    ).rejects.toThrow("recentMinutes must be a positive integer");
  });
});
