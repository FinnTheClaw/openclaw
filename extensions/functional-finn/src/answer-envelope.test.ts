import { describe, expect, it, vi } from "vitest";
import {
  parseFunctionalFinnAnswerEnvelope,
  validateFunctionalFinnAnswer,
  type FunctionalFinnAnswerEnvelope,
  type FunctionalFinnEvidence,
} from "./answer-envelope.js";

const evidence: FunctionalFinnEvidence = {
  evidenceId: "tool:1",
  agentId: "finn",
  content: "service state: healthy",
  observedAt: 100,
  freshnessUntil: 200,
  sourceKind: "tool_observation",
  state: "current",
};

function factual(): FunctionalFinnAnswerEnvelope {
  return {
    schemaVersion: 1,
    responseClass: "factual",
    answerText: "The service is healthy.",
    abstain: false,
    claims: [
      {
        claimId: "c1",
        text: "The service is healthy.",
        classification: "observed",
        confidence: 0.99,
        sources: [{ evidenceId: "tool:1", start: 15, end: 22, quote: "healthy" }],
      },
    ],
  };
}

describe("Functional Finn answer envelope", () => {
  it("accepts an exact current supporting span", async () => {
    const supportScore = vi.fn().mockResolvedValue(0.95);
    await expect(
      validateFunctionalFinnAnswer({
        envelope: factual(),
        agentId: "finn",
        now: 150,
        lookupEvidence: () => evidence,
        supportScore,
      }),
    ).resolves.toEqual({ ok: true });
    expect(supportScore).toHaveBeenCalledWith("The service is healthy.", "healthy");
  });

  it.each([
    ["wrong span", { ...evidence, content: "service state: failed" }, "UNSUPPORTED_CLAIM"],
    ["stale", { ...evidence, freshnessUntil: 149 }, "STALE_EVIDENCE"],
    ["quarantined", { ...evidence, state: "quarantined" as const }, "UNSUPPORTED_CLAIM"],
    ["wrong scope", { ...evidence, agentId: "other" }, "WRONG_SCOPE"],
  ])("rejects %s evidence", async (_name, candidate, code) => {
    await expect(
      validateFunctionalFinnAnswer({
        envelope: factual(),
        agentId: "finn",
        now: 150,
        lookupEvidence: () => candidate,
        supportScore: async () => 0.95,
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code } });
  });

  it("rejects unsupported semantics", async () => {
    await expect(
      validateFunctionalFinnAnswer({
        envelope: factual(),
        agentId: "finn",
        now: 150,
        lookupEvidence: () => evidence,
        supportScore: async () => 0.49,
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: "SEMANTIC_SUPPORT_FAILED" } });
  });

  it("allows only mechanically bounded non-factual acknowledgements", async () => {
    const acknowledgement = (answerText: string): FunctionalFinnAnswerEnvelope => ({
      schemaVersion: 1,
      responseClass: "non_factual_ack",
      answerText,
      abstain: false,
      claims: [],
    });
    for (const answerText of ["Thanks!", "Got it.", "Okay"]) {
      await expect(
        validateFunctionalFinnAnswer({
          envelope: acknowledgement(answerText),
          agentId: "finn",
          now: 1,
          lookupEvidence: () => undefined,
          supportScore: async () => 0,
        }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      validateFunctionalFinnAnswer({
        envelope: acknowledgement("The server is healthy."),
        agentId: "finn",
        now: 1,
        lookupEvidence: () => undefined,
        supportScore: async () => 1,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("strictly parses JSON envelopes", () => {
    expect(parseFunctionalFinnAnswerEnvelope(JSON.stringify(factual()))).toEqual(factual());
    expect(parseFunctionalFinnAnswerEnvelope("not json")).toBeUndefined();
    expect(parseFunctionalFinnAnswerEnvelope({ ...factual(), schemaVersion: 2 })).toBeUndefined();
  });
});
