import { describe, expect, it } from "vitest";
import {
  C01_PROPORTIONAL_PLANNING_CAMPAIGN,
  type C01CampaignClass,
} from "./c01-proportional-planning-campaign.fixture.js";

const CLASSES: readonly C01CampaignClass[] = [
  "quick-direct",
  "focused-readonly",
  "focused-effectful",
  "deep-action-estimate",
  "deep-branch-estimate",
];

describe("C01 proportional planning real-model campaign corpus", () => {
  it("contains exactly 100 unique no-side-effect cases with balanced class coverage", () => {
    expect(C01_PROPORTIONAL_PLANNING_CAMPAIGN).toHaveLength(100);
    expect(new Set(C01_PROPORTIONAL_PLANNING_CAMPAIGN.map((item) => item.id)).size).toBe(100);
    expect(new Set(C01_PROPORTIONAL_PLANNING_CAMPAIGN.map((item) => item.prompt)).size).toBe(100);
    for (const caseClass of CLASSES) {
      expect(
        C01_PROPORTIONAL_PLANNING_CAMPAIGN.filter((item) => item.caseClass === caseClass),
      ).toHaveLength(20);
    }
  });

  it("keeps quick work direct while requiring pre-tool plans for focused and deep work", () => {
    for (const item of C01_PROPORTIONAL_PLANNING_CAMPAIGN) {
      expect(item.prompt).toContain("no-side-effect");
      if (item.caseClass === "quick-direct") {
        expect(item).toMatchObject({
          expectedMode: "QUICK",
          requiresPlan: false,
          expectedToolPolicy: "forbidden",
        });
      } else {
        expect(item).toMatchObject({ requiresPlan: true, expectedToolPolicy: "required" });
        expect(item.prompt).toContain("before the first tool call");
        expect(item.prompt).toContain("tool-count target");
      }
    }
  });

  it("fixes classification edges without imposing a tool-count target", () => {
    for (const item of C01_PROPORTIONAL_PLANNING_CAMPAIGN) {
      if (item.caseClass === "deep-action-estimate") {
        expect(item).toMatchObject({ expectedMode: "DEEP", estimatedUsefulActions: 13 });
      }
      if (item.caseClass === "deep-branch-estimate") {
        expect(item).toMatchObject({ expectedMode: "DEEP", independentBranches: 4 });
      }
      expect(item.prompt).not.toMatch(/exactly \d+ tool|at least \d+ tool/u);
    }
  });
});
