import { beforeEach, describe, expect, it, vi } from "vitest";

const validate = vi.hoisted(() => vi.fn());
vi.mock("./release-authority-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./release-authority-client.js")>();
  return { ...original, validateFunctionalFinnCandidate: validate };
});

const { createFunctionalFinnExternalReleasePolicy } = await import("./external-release-policy.js");

function store<T>() {
  const values = new Map<string, T>();
  return {
    lookup: (key: string) => values.get(key),
    registerIfAbsent: (key: string, value: T) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
  };
}

function context(content = "Observed fact.") {
  return {
    sender: {
      functionalFinnIngress: {
        schema: 1,
        ingressId: "ingress-1",
        bindingId: "binding-1",
        accountId: "finn",
        sourceId: "source-1",
        contentDigest: "a".repeat(64),
        content,
        receivedAt: 100,
        sequence: 1,
        candidateSocketPath: "/private/run/finnrel.sock",
        timeoutMs: 500,
      },
    },
  };
}

function envelope(answer = "Observed fact.") {
  return JSON.stringify({
    schemaVersion: 1,
    responseClass: "factual",
    answerText: answer,
    abstain: false,
    claims: [
      {
        claimId: "claim-1",
        text: answer,
        classification: "observed",
        confidence: 0.9,
        sources: [{ evidenceId: "ingress-1", start: 0, end: 14, quote: "Observed fact." }],
      },
    ],
  });
}

describe("Functional Finn two-phase external release policy", () => {
  beforeEach(() => {
    validate.mockReset();
  });

  it("permits exactly one revision and attaches only the validated escrow", async () => {
    validate
      .mockResolvedValueOnce({ status: "revision_required" })
      .mockResolvedValueOnce({ status: "validated" });
    const policy = createFunctionalFinnExternalReleasePolicy({
      candidates: store(),
      revisions: store(),
    });
    policy.bindRun("run-1", context());
    await expect(
      policy.beforeFinalize({
        text: envelope(),
        sessionKey: "session-1",
        runId: "run-1",
        channelContext: context(),
      }),
    ).resolves.toMatchObject({ action: "revise", retry: { maxAttempts: 1 } });
    await expect(
      policy.beforeFinalize({
        text: envelope(),
        sessionKey: "session-1",
        runId: "run-1",
        channelContext: context(),
      }),
    ).resolves.toMatchObject({ action: "continue" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.calls[0]?.[0].candidate.revision).toBe(0);
    expect(validate.mock.calls[1]?.[0].candidate.revision).toBe(1);
    expect(
      policy.prepareReply({ text: envelope(), sessionKey: "session-1", runId: "run-1" }),
    ).toMatchObject({ escrow: { kind: "external_release_escrow" } });
    expect(
      policy.prepareReply({
        text: envelope("Changed after validation."),
        sessionKey: "session-1",
        runId: "run-1",
      }),
    ).toEqual({ blocked: true });
  });

  it("fails closed after the single revision when validation remains unavailable", async () => {
    validate.mockRejectedValue(new Error("authority unavailable"));
    const policy = createFunctionalFinnExternalReleasePolicy({
      candidates: store(),
      revisions: store(),
    });
    policy.bindRun("run-2", context());
    const first = await policy.beforeFinalize({
      text: envelope(),
      sessionKey: "session-2",
      runId: "run-2",
      channelContext: context(),
    });
    const second = await policy.beforeFinalize({
      text: envelope(),
      sessionKey: "session-2",
      runId: "run-2",
      channelContext: context(),
    });
    const replay = await policy.beforeFinalize({
      text: envelope(),
      sessionKey: "session-2",
      runId: "run-2",
      channelContext: context(),
    });
    expect(first).toMatchObject({ action: "revise" });
    expect(second).toMatchObject({ action: "continue" });
    expect(replay).toMatchObject({ action: "continue" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(
      policy.prepareReply({ text: envelope(), sessionKey: "session-2", runId: "run-2" }),
    ).toEqual({ blocked: true });
  });

  it("converts exact UTF-16 astral spans to UTF-8 byte offsets", async () => {
    validate.mockResolvedValue({ status: "validated" });
    const policy = createFunctionalFinnExternalReleasePolicy({
      candidates: store(),
      revisions: store(),
    });
    const ingress = context("A🙂 fact");
    const text = JSON.stringify({
      schemaVersion: 1,
      responseClass: "factual",
      answerText: "🙂",
      abstain: false,
      claims: [
        {
          claimId: "claim-astral",
          text: "🙂",
          classification: "observed",
          confidence: 0.9,
          sources: [{ evidenceId: "ingress-1", start: 1, end: 3, quote: "🙂" }],
        },
      ],
    });
    policy.bindRun("run-astral", ingress);
    await policy.beforeFinalize({
      text,
      sessionKey: "session-astral",
      runId: "run-astral",
      channelContext: ingress,
    });
    expect(validate.mock.calls[0]?.[0].candidate.claims[0].evidence[0]).toMatchObject({
      startByte: 1,
      endByte: 5,
      quote: "🙂",
    });
  });

  it.each(["cafe\u0301", "bad\rcontrol", "bad\ud800surrogate"])(
    "rejects non-canonical trusted ingress %j before authority IPC",
    async (content) => {
      const policy = createFunctionalFinnExternalReleasePolicy({
        candidates: store(),
        revisions: store(),
      });
      await expect(
        policy.beforeFinalize({
          text: envelope(),
          sessionKey: "session-invalid",
          runId: "run-invalid",
          channelContext: context(content),
        }),
      ).resolves.toBeUndefined();
      expect(validate).not.toHaveBeenCalled();
    },
  );
});
