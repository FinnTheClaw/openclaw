import { describe, expect, it } from "vitest";
import {
  C04A_AGGREGATE_COMPLETENESS_CAMPAIGN,
  type C04aCampaignClass,
} from "./c04a-aggregate-completeness-campaign.fixture.js";

const CLASSES: readonly C04aCampaignClass[] = [
  "exact-map",
  "duplicate-required",
  "extra-known-optional",
  "stale-or-inadmissible",
  "restart-or-concurrency",
];

describe("C04a aggregate-completeness real-model campaign corpus", () => {
  it("contains exactly 100 unique no-side-effect cases with balanced class coverage", () => {
    expect(C04A_AGGREGATE_COMPLETENESS_CAMPAIGN).toHaveLength(100);
    expect(new Set(C04A_AGGREGATE_COMPLETENESS_CAMPAIGN.map((item) => item.id)).size).toBe(100);
    expect(new Set(C04A_AGGREGATE_COMPLETENESS_CAMPAIGN.map((item) => item.prompt)).size).toBe(100);
    for (const caseClass of CLASSES) {
      expect(
        C04A_AGGREGATE_COMPLETENESS_CAMPAIGN.filter((item) => item.caseClass === caseClass),
      ).toHaveLength(20);
    }
  });

  it("keeps the exact required criterion cohort immutable in every case", () => {
    for (const item of C04A_AGGREGATE_COMPLETENESS_CAMPAIGN) {
      expect(item.requiredCriteria).toEqual(["observe-a", "observe-b", "observe-c"]);
      expect(item.prompt).toContain("no-side-effect");
      if (item.expectedDecision === "accept") {
        expect(item.evidenceCriterionIds).toEqual(item.requiredCriteria);
      }
    }
  });

  it("requires explicit duplicate, extra, and stale rejection evidence", () => {
    for (const item of C04A_AGGREGATE_COMPLETENESS_CAMPAIGN) {
      if (item.caseClass === "duplicate-required") {
        expect(item.expectedReason).toBe("duplicate");
        expect(new Set(item.evidenceCriterionIds).size).toBeLessThan(
          item.evidenceCriterionIds.length,
        );
      }
      if (item.caseClass === "extra-known-optional") {
        expect(item.expectedReason).toBe("extra");
        expect(item.evidenceCriterionIds).toContain("observe-optional");
      }
      if (item.caseClass === "stale-or-inadmissible") {
        expect(item.expectedReason).toBe("stale");
        expect(item.staleDimension).toBeDefined();
      }
    }
  });
});
