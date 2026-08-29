import { describe, expect, it } from "vitest";
import { C03_DEEP_LOOP_CAMPAIGN, type C03CampaignClass } from "./c03-deep-loop-campaign.fixture.js";

const CLASSES: readonly C03CampaignClass[] = [
  "baseline-loop",
  "transient-retry",
  "non-guidance-replan",
  "premature-finish",
  "restart-lifecycle",
];

describe("C03 deep productive-loop real-model campaign corpus", () => {
  it("contains exactly 100 unique no-side-effect cases with balanced class coverage", () => {
    expect(C03_DEEP_LOOP_CAMPAIGN).toHaveLength(100);
    expect(new Set(C03_DEEP_LOOP_CAMPAIGN.map((item) => item.id)).size).toBe(100);
    expect(new Set(C03_DEEP_LOOP_CAMPAIGN.map((item) => item.prompt)).size).toBe(100);
    for (const caseClass of CLASSES) {
      expect(C03_DEEP_LOOP_CAMPAIGN.filter((item) => item.caseClass === caseClass)).toHaveLength(
        20,
      );
    }
  });

  it("keeps the historical 20-observation productive-loop invariant explicit", () => {
    for (const item of C03_DEEP_LOOP_CAMPAIGN) {
      expect(item.requiredUniqueObservations).toBe(20);
      expect(item.expectedAggregateCount).toBe(1);
      expect(item.prompt).toContain("no-side-effect");
    }
  });

  it("makes retry, replan, premature-finish, and restart stress expectations non-optional", () => {
    for (const item of C03_DEEP_LOOP_CAMPAIGN) {
      if (item.caseClass === "transient-retry") expect(item.expectedTransientFailures).toBe(1);
      if (item.caseClass === "non-guidance-replan") expect(item.expectedReplans).toBe(1);
      if (item.caseClass === "premature-finish")
        expect(item.expectedPrematureFinishRejections).toBe(1);
      if (item.caseClass === "restart-lifecycle")
        expect([8, 12]).toContain(item.restartAfterObservations);
    }
  });
});
