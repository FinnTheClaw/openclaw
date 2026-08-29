import { describe, expect, it } from "vitest";
import {
  C01_DEEP_BRANCHES,
  C01_DEEP_SUBACTIONS,
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

  it("keeps expected policy hidden while making each task's material facts model-visible", () => {
    for (const item of C01_PROPORTIONAL_PLANNING_CAMPAIGN) {
      expect(item.prompt).not.toMatch(
        /before the first tool call|create a work plan|expectedMode|classify/u,
      );
      if (item.caseClass === "quick-direct") {
        expect(item).toMatchObject({
          expectedMode: "QUICK",
          requiresPlan: false,
          expectedToolPolicy: "forbidden",
        });
      } else {
        expect(item).toMatchObject({ requiresPlan: true, expectedToolPolicy: "required" });
      }
    }
  });

  it("encodes effectful, thirteen-action, and four-branch pressure in the visible prompts", () => {
    for (const item of C01_PROPORTIONAL_PLANNING_CAMPAIGN) {
      if (item.caseClass === "focused-effectful") {
        expect(item.prompt).toContain("simulated action contract");
        expect(item.prompt).toContain("disposable in-memory test record");
        expect(item.prompt).toContain(item.simulatedActionTarget!.split("=")[1]);
      }
      if (item.caseClass === "deep-action-estimate") {
        expect(item).toMatchObject({ expectedMode: "DEEP", estimatedUsefulActions: 13 });
        expect(item.requiredSubactions).toEqual(C01_DEEP_SUBACTIONS);
        for (const subaction of C01_DEEP_SUBACTIONS) {
          expect(item.prompt).toContain(subaction);
        }
      }
      if (item.caseClass === "deep-branch-estimate") {
        expect(item).toMatchObject({ expectedMode: "DEEP", independentBranches: 4 });
        expect(item.requiredBranchNames).toEqual(C01_DEEP_BRANCHES);
        for (const branch of C01_DEEP_BRANCHES) {
          expect(item.prompt).toContain(branch);
        }
      }
      expect(item.prompt).not.toMatch(/exactly \d+ tool|at least \d+ tool/u);
    }
  });

  it("prevents the nonquick classes from collapsing to one prompt contract", () => {
    const representative = (caseClass: C01CampaignClass) =>
      C01_PROPORTIONAL_PLANNING_CAMPAIGN.find((item) => item.caseClass === caseClass)!.prompt;
    const signatures = CLASSES.map((caseClass) => {
      const prompt = representative(caseClass);
      return JSON.stringify({
        promptOnly: prompt.includes("prompt only"),
        readonlyUnknown: prompt.includes("current value is not supplied"),
        simulatedEffect: prompt.includes("simulated action contract"),
        visibleSubactions: C01_DEEP_SUBACTIONS.filter((name) => prompt.includes(name)).length,
        visibleBranches: C01_DEEP_BRANCHES.filter((name) => prompt.includes(name)).length,
      });
    });
    expect(new Set(signatures).size).toBe(CLASSES.length);
  });
});
