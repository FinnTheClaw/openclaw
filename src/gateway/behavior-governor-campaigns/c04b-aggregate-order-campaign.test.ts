import { describe, expect, it } from "vitest";
import {
  C04B_AGGREGATE_ORDER_CAMPAIGN,
  type C04bCampaignPhase,
} from "./c04b-aggregate-order-campaign.fixture.js";

const PHASES: readonly C04bCampaignPhase[] = [
  "early-attempt",
  "permuted-observation",
  "retry-before-aggregate",
  "restart-before-aggregate",
  "concurrent-completion",
];

describe("C04b aggregate-order real-model campaign corpus", () => {
  it("contains exactly 100 unique, no-side-effect cases with balanced phase coverage", () => {
    expect(C04B_AGGREGATE_ORDER_CAMPAIGN).toHaveLength(100);
    expect(new Set(C04B_AGGREGATE_ORDER_CAMPAIGN.map((item) => item.id)).size).toBe(100);
    expect(new Set(C04B_AGGREGATE_ORDER_CAMPAIGN.map((item) => item.prompt)).size).toBe(100);
    for (const phase of PHASES) {
      expect(C04B_AGGREGATE_ORDER_CAMPAIGN.filter((item) => item.phase === phase)).toHaveLength(20);
    }
  });

  it("requires three distinct observations and an early rejection before final admission", () => {
    for (const item of C04B_AGGREGATE_ORDER_CAMPAIGN) {
      expect(new Set(item.requiredCriteria).size).toBe(3);
      expect(new Set(item.successfulOrder).size).toBe(3);
      expect([...item.successfulOrder].toSorted()).toEqual([...item.requiredCriteria].toSorted());
      expect(item.earlyAggregateAfterSuccesses).toBeLessThan(item.requiredCriteria.length);
      expect(item.prompt).toContain("no-side-effect");
    }
  });

  it("keeps restart, retry, and concurrent-final stress cases explicit", () => {
    for (const item of C04B_AGGREGATE_ORDER_CAMPAIGN) {
      if (item.phase === "retry-before-aggregate") {
        expect(item.failedCriterionBeforeSuccess).toBe(item.successfulOrder[0]);
      }
      if (item.phase === "restart-before-aggregate") {
        expect(item.restartAfterSuccesses).toBe(2);
      }
      if (item.phase === "concurrent-completion") {
        expect(item.concurrentFinalCriteria).toEqual(item.successfulOrder.slice(1));
      }
    }
  });
});
