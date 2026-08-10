import { describe, expect, it } from "vitest";
import { EvidenceRecoveryTracker } from "./evidence-recovery.js";

function observation(
  result: unknown,
  overrides: Partial<Parameters<EvidenceRecoveryTracker["observe"]>[0]> = {},
) {
  return {
    toolName: "memory_recall",
    result,
    isError: false,
    hasUsableEvidence: true,
    isUnavailable: false,
    ...overrides,
  };
}

describe("Active Memory evidence recovery", () => {
  it.each([3, 4, 5, 6])("accepts a bounded tool-call budget of %s", (budget) => {
    expect(() => new EvidenceRecoveryTracker(budget)).not.toThrow();
  });

  it.each([2, 7, 3.5])("rejects an out-of-contract tool-call budget of %s", (budget) => {
    expect(() => new EvidenceRecoveryTracker(budget)).toThrow(RangeError);
  });

  it("cuts off an unchanged result without spending the remaining budget", () => {
    const tracker = new EvidenceRecoveryTracker(6);
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBe("unchanged_evidence");

    expect(
      tracker.finalize({ hasUsableEvidence: true, hasFinalSummary: false, noReply: false }),
    ).toMatchObject({
      callsUsed: 2,
      progressTransitions: 0,
      terminationReason: "unchanged_evidence",
      unmetAcceptanceCriteria: ["The sidecar must finalize with one compact memory note or NONE."],
    });
  });

  it("does not mistake transport timing churn for new evidence", () => {
    const tracker = new EvidenceRecoveryTracker(6);
    expect(
      tracker.observe(
        observation({ hits: ["alpha"], requestId: "req-1", elapsedMs: 12, updatedAt: 100 }),
      ),
    ).toBeUndefined();
    expect(
      tracker.observe(
        observation({ hits: ["alpha"], requestId: "req-2", elapsedMs: 19, updatedAt: 200 }),
      ),
    ).toBe("unchanged_evidence");
  });

  it("resets unchanged-result detection when discriminating evidence changes", () => {
    const tracker = new EvidenceRecoveryTracker(6);
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["beta"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["beta"] }))).toBe("unchanged_evidence");

    expect(
      tracker.finalize({ hasUsableEvidence: true, hasFinalSummary: false, noReply: false }),
    ).toMatchObject({ callsUsed: 3, progressTransitions: 1 });
  });

  it("permits one changed strategy before stopping an unchanged result", () => {
    const tracker = new EvidenceRecoveryTracker(6);
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBeUndefined();
    expect(
      tracker.observe(observation({ hits: ["alpha"] }, { toolName: "memory_get" })),
    ).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["alpha"] }, { toolName: "memory_get" }))).toBe(
      "unchanged_evidence",
    );
  });

  it("stops repeated unavailable or empty cycles early and records exact failures", () => {
    const tracker = new EvidenceRecoveryTracker(6);
    const unavailable = observation(
      { status: "unavailable" },
      { hasUsableEvidence: false, isUnavailable: true },
    );
    expect(tracker.observe(unavailable)).toBeUndefined();
    expect(tracker.observe({ ...unavailable, result: { status: "empty" } })).toBe(
      "repeated_unavailable_or_empty",
    );

    expect(
      tracker.finalize({ hasUsableEvidence: false, hasFinalSummary: false, noReply: false }),
    ).toEqual({
      callsUsed: 2,
      progressTransitions: 1,
      terminationReason: "repeated_unavailable_or_empty",
      unmetAcceptanceCriteria: [
        "A memory tool must return usable evidence relevant to the bounded search query.",
      ],
      unsupportedClaims: [],
      contradictions: [],
      semanticFailures: ["Memory tool memory_recall reported unavailable."],
      missingEvidence: ["Memory tool memory_recall returned no usable evidence."],
    });
  });

  it("enforces the hard cap even when each result changes", () => {
    const tracker = new EvidenceRecoveryTracker(3);
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["beta"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["gamma"] }))).toBe("hard_budget");

    expect(
      tracker.finalize({ hasUsableEvidence: true, hasFinalSummary: false, noReply: false }),
    ).toMatchObject({
      callsUsed: 3,
      progressTransitions: 2,
      terminationReason: "hard_budget",
    });
  });

  it("accepts a valid terminal receipt on the exact budget boundary", () => {
    const tracker = new EvidenceRecoveryTracker(3);
    expect(tracker.observe(observation({ hits: ["alpha"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["beta"] }))).toBeUndefined();
    expect(tracker.observe(observation({ hits: ["gamma"] }))).toBe("hard_budget");

    expect(
      tracker.finalize({ hasUsableEvidence: true, hasFinalSummary: true, noReply: false }),
    ).toMatchObject({
      callsUsed: 3,
      terminationReason: "completed",
      unmetAcceptanceCriteria: [],
    });
  });

  it("emits a complete successful finalization receipt", () => {
    const tracker = new EvidenceRecoveryTracker(4);
    tracker.observe(observation({ hits: ["alpha"] }));

    expect(
      tracker.finalize({ hasUsableEvidence: true, hasFinalSummary: true, noReply: false }),
    ).toEqual({
      callsUsed: 1,
      progressTransitions: 0,
      terminationReason: "completed",
      unmetAcceptanceCriteria: [],
      unsupportedClaims: [],
      contradictions: [],
      semanticFailures: [],
      missingEvidence: [],
    });
  });

  it("refuses success while explicit semantic or evidence blockers remain", () => {
    const tracker = new EvidenceRecoveryTracker(4);
    tracker.observe({
      toolName: "memory_forget",
      result: { action: "partial_failure", postconditions: { semanticAbsent: false } },
      isError: false,
      hasUsableEvidence: true,
      isUnavailable: false,
    });

    expect(
      tracker.finalize({
        hasUsableEvidence: true,
        hasFinalSummary: true,
        noReply: false,
        unsupportedClaims: ["The old contact label was asserted without structured evidence."],
        contradictions: ["Historical memory conflicts with the current access inventory."],
        semanticFailures: ["Forget returned partial_failure: semanticAbsent=false."],
      }),
    ).toMatchObject({
      terminationReason: "failed",
      unmetAcceptanceCriteria: [
        "Every unsupported claim must be removed or supported by evidence.",
        "Every contradiction must be resolved against current evidence.",
        "Every semantic failure must reach a typed successful postcondition.",
      ],
    });
  });

  it("preserves NONE and NO_REPLY as a conclusive no-relevant-memory outcome", () => {
    const tracker = new EvidenceRecoveryTracker(4);
    tracker.observe(
      observation({ status: "empty" }, { hasUsableEvidence: false, isUnavailable: false }),
    );

    expect(
      tracker.finalize({ hasUsableEvidence: false, hasFinalSummary: false, noReply: true }),
    ).toMatchObject({
      callsUsed: 1,
      terminationReason: "no_relevant_memory",
      unmetAcceptanceCriteria: [],
    });
  });
});
