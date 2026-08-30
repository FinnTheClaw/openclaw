import { describe, expect, it } from "vitest";
import {
  bindGovernorLoopAttemptEvidence,
  resolveGovernorLoopAttemptEvidence,
} from "./governor-loop-evidence-channel.js";

describe("governor loop evidence channel", () => {
  it("accepts only the exact closure-bound attempt object", () => {
    const evidence = Object.freeze({ decision: "complete" });
    const attempt = bindGovernorLoopAttemptEvidence({ status: "done" }, evidence);
    const forgedProviderMessage = { ...attempt, governorEvidence: evidence };
    expect(resolveGovernorLoopAttemptEvidence(attempt)).toBe(evidence);
    expect(resolveGovernorLoopAttemptEvidence(forgedProviderMessage)).toBeUndefined();
    expect(resolveGovernorLoopAttemptEvidence({ status: "done" })).toBeUndefined();
  });
});
