import { describe, expect, it } from "vitest";
import {
  C03_CANONICAL_OBSERVATION_KEYS,
  C03_DEEP_LOOP_CAMPAIGN,
  type C03CampaignClass,
  type C03TraceEvent,
  validateC03Trace,
} from "./c03-deep-loop-campaign.fixture.js";

const CLASSES: readonly C03CampaignClass[] = [
  "baseline-loop",
  "transient-retry",
  "non-guidance-replan",
  "premature-finish",
  "restart-lifecycle",
];

function replaceEvent(
  trace: readonly C03TraceEvent[],
  index: number,
  event: C03TraceEvent,
): C03TraceEvent[] {
  const copy = [...trace];
  copy[index] = event;
  return copy;
}

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

  it("encodes and accepts only the exact 24-turn productive trace", () => {
    for (const campaignCase of C03_DEEP_LOOP_CAMPAIGN) {
      const trace = campaignCase.expectedTrace;
      expect(trace).toHaveLength(24);
      expect(trace.map((event) => event.turn)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      );
      const observations = trace.filter(
        (event): event is Extract<C03TraceEvent, { kind: "observation" }> =>
          event.kind === "observation",
      );
      const successes = observations.filter((event) => event.result === "success");
      expect(successes.map((event) => event.observationKey)).toEqual(
        C03_CANONICAL_OBSERVATION_KEYS,
      );
      expect(observations.filter((event) => event.result === "transient-failure")).toHaveLength(1);
      const failureIndex = trace.findIndex(
        (event) => event.kind === "observation" && event.result === "transient-failure",
      );
      expect(trace[failureIndex + 1]).toMatchObject({ kind: "replan", guidance: false });
      expect(trace[failureIndex + 2]).toMatchObject({
        kind: "observation",
        observationKey: observations.find((event) => event.result === "transient-failure")!
          .observationKey,
        result: "success",
      });
      expect(trace.filter((event) => event.kind === "finish-rejected")).toHaveLength(1);
      expect(trace.at(-1)).toMatchObject({ kind: "aggregate", turn: 24 });
      expect(validateC03Trace(campaignCase, trace)).toEqual([]);
    }
  });

  it("rejects duplicate labels, invented keys, orphan outcomes, wrong order, and wrong count", () => {
    const campaignCase = C03_DEEP_LOOP_CAMPAIGN[0]!;
    const trace = campaignCase.expectedTrace;
    const successIndexes = trace
      .map((event, index) => ({ event, index }))
      .filter(
        (item): item is { event: Extract<C03TraceEvent, { kind: "observation" }>; index: number } =>
          item.event.kind === "observation" && item.event.result === "success",
      )
      .map((item) => item.index);
    const firstSuccess = trace[successIndexes[0]!] as Extract<
      C03TraceEvent,
      { kind: "observation" }
    >;
    const secondSuccess = trace[successIndexes[1]!] as Extract<
      C03TraceEvent,
      { kind: "observation" }
    >;
    const duplicate = replaceEvent(trace, successIndexes[1]!, {
      ...secondSuccess,
      observationKey: firstSuccess.observationKey,
    });
    expect(validateC03Trace(campaignCase, duplicate)).toContain("C03_TRACE_DUPLICATE_LABEL");
    const invented = replaceEvent(trace, successIndexes[0]!, {
      ...firstSuccess,
      observationKey: "observe-invented",
    });
    expect(validateC03Trace(campaignCase, invented)).toContain("C03_TRACE_INVENTED_KEY");
    const orphan = replaceEvent(trace, successIndexes[0]!, {
      ...firstSuccess,
      effectId: "",
    });
    expect(validateC03Trace(campaignCase, orphan)).toContain("C03_TRACE_ORPHAN_OUTCOME");
    const wrongOrder = [...trace];
    [wrongOrder[successIndexes[0]!], wrongOrder[successIndexes[1]!]] = [
      wrongOrder[successIndexes[1]!]!,
      wrongOrder[successIndexes[0]!]!,
    ];
    expect(validateC03Trace(campaignCase, wrongOrder)).toContain(
      "C03_TRACE_ORDER_OR_VALUE_INVALID",
    );
    expect(validateC03Trace(campaignCase, trace.slice(0, -1))).toContain("C03_TRACE_COUNT_INVALID");
  });
});
