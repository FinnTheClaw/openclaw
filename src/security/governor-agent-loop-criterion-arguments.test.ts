import { describe, expect, it } from "vitest";
import type { GovernorAgentLoopToolBinding } from "./governor-agent-loop-config.js";
import { validateGovernorCriterionArguments } from "./governor-agent-loop-criterion-arguments.js";

const binding: GovernorAgentLoopToolBinding = {
  toolName: "observe",
  capability: "fixture.observe",
  canonicalTarget: "fixture:observe",
  criterionArgument: "key",
  criteriaByValue: { alpha: "alpha", beta: "beta" },
  implementationId: "disposable-observation-v1",
};

describe("governor criterion argument validation", () => {
  it("requires the host-declared criterion argument", () => {
    expect(validateGovernorCriterionArguments({ binding, args: {} })).toBe(
      "GOVERNOR_TOOL_ARGUMENT_REQUIRED:key;ALLOWED:alpha,beta",
    );
  });

  it("rejects unknown criterion values before admission", () => {
    expect(validateGovernorCriterionArguments({ binding, args: { key: "gamma" } })).toBe(
      "GOVERNOR_TOOL_ARGUMENT_INVALID:key;ALLOWED:alpha,beta",
    );
  });

  it("accepts an exactly bound criterion value", () => {
    expect(validateGovernorCriterionArguments({ binding, args: { key: "alpha" } })).toBeUndefined();
  });
});
