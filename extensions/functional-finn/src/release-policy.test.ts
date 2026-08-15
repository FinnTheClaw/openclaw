import { describe, expect, it, vi } from "vitest";
import { FunctionalFinnEvidenceStore } from "./evidence-store.js";
import {
  createFunctionalFinnReleasePolicy,
  type FunctionalFinnVerifier,
} from "./release-policy.js";

function memoryStore<T>() {
  const values = new Map<string, T>();
  return {
    register: (key: string, value: T) => void values.set(key, value),
    registerIfAbsent: (key: string, value: T) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: (key: string) => values.get(key),
    entries: () => [...values].map(([key, value]) => ({ key, value })),
  };
}

function fixture(
  verify: FunctionalFinnVerifier = vi.fn(async () => ({
    ok: false as const,
    code: "UNSUPPORTED",
  })),
) {
  const sessions = memoryStore<{ agentId: string; channel: string }>();
  const revisions = memoryStore<{ requested: true }>();
  const evidence = new FunctionalFinnEvidenceStore(memoryStore());
  const policy = createFunctionalFinnReleasePolicy({
    config: {
      agentIds: ["finn"],
      channels: ["signal"],
      verifierSocketPath: "/tmp/verifier.sock",
      verifierTimeoutMs: 500,
    },
    sessions,
    revisions,
    evidence,
    verify,
  });
  policy.bindSession({ sessionKey: "s", agentId: "finn", channel: "signal" });
  return { policy, evidence, verify };
}

describe("Functional Finn release policy", () => {
  it("requests exactly one revision and then leaves the physical gate fail closed", async () => {
    const { policy } = fixture();
    const first = await policy.beforeFinalize({ text: "bad", sessionKey: "s", runId: "r" });
    const second = await policy.beforeFinalize({ text: "still bad", sessionKey: "s", runId: "r" });
    expect(first?.action).toBe("revise");
    expect(first?.retry.maxAttempts).toBe(1);
    expect(second).toBeUndefined();
    await expect(
      policy.prepareReply({
        text: "still bad",
        sessionKey: "s",
        runId: "r",
        channel: "signal",
        accountId: "a",
        target: "+1",
      }),
    ).resolves.toEqual({ cancel: true, reason: "Functional Finn answer envelope is invalid" });
  });

  it("attaches a receipt only after exact evidence-bound verification", async () => {
    const verify = vi.fn(async () => ({ ok: true as const, receipt: { receiptId: "rr" } }));
    const { policy, evidence } = fixture(verify);
    const observed = evidence.recordToolObservation({
      agentId: "finn",
      runId: "r",
      toolCallId: "tc",
      toolName: "read",
      result: "status=healthy",
      observedAt: 100,
    });
    const text = JSON.stringify({
      schemaVersion: 1,
      responseClass: "factual",
      answerText: "The service is healthy.",
      abstain: false,
      claims: [
        {
          claimId: "c1",
          text: "The service is healthy.",
          classification: "observed",
          confidence: 0.95,
          sources: [{ evidenceId: observed.evidenceId, start: 7, end: 14, quote: "healthy" }],
        },
      ],
    });
    const result = await policy.prepareReply({
      text,
      sessionKey: "s",
      runId: "r",
      channel: "signal",
      accountId: "a",
      target: "+1",
    });
    expect(result).toEqual({ text: "The service is healthy.", receipt: { receiptId: "rr" } });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ evidence: [observed] }));
  });

  it("does not govern unbound sessions", async () => {
    const { policy, verify } = fixture();
    expect(
      await policy.prepareReply({
        text: "ordinary",
        sessionKey: "other",
        runId: "r",
        channel: "signal",
      }),
    ).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
});
