// Voice Call tests cover manager.closed loop plugin behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "./manager.test-harness.js";

function requireTurnToken(provider: Awaited<ReturnType<typeof createManagerHarness>>["provider"]) {
  const firstStart = provider.startListeningCalls[0];
  if (!firstStart?.turnToken) {
    throw new Error("expected closed-loop turn to capture a turn token");
  }
  return firstStart.turnToken;
}

function expectTranscriptWaiter(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const waiters = (
    manager as unknown as {
      transcriptWaiters: Map<string, unknown>;
    }
  ).transcriptWaiters;
  expect(waiters.has(callId)).toBe(true);
}

describe("CallManager closed-loop turns", () => {
  it.each(["early-final", "wrong-nonce", "setup-failure", "call-ended", "shutdown"] as const)(
    "pending listening continuation: %s",
    async (phase) => {
      const { manager, provider } = await createManagerHarness(
        { transcriptTimeoutMs: 5000 },
        new FakeProvider("twilio"),
      );
      const started = await manager.initiateCall("+15550000006");
      expect(started.success).toBe(true);
      await markCallAnswered(manager, started.callId, `evt-${phase}-answered`);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const startListening = provider.startListening.bind(provider);
      const listening = vi.spyOn(provider, "startListening").mockImplementation(async (input) => {
        await startListening(input);
        entered.resolve();
        await release.promise;
        if (phase === "setup-failure") {
          throw new Error("synthetic listening setup failed");
        }
      });
      const transient = manager as unknown as {
        transcriptWaiters: Map<string, unknown>;
        activeTurnCalls: Set<string>;
      };
      const turn = manager.continueCall(started.callId, "Pending question");
      let retirement: Promise<unknown> | undefined;
      let stopping: Promise<void> | undefined;
      const endedEvent = {
        id: `evt-${phase}-ended`,
        type: "call.ended" as const,
        callId: started.callId,
        providerCallId: "request-uuid",
        timestamp: Date.now(),
        reason: "hangup-user" as const,
      };
      try {
        await entered.promise;
        const turnToken = requireTurnToken(provider);
        if (phase === "early-final" || phase === "wrong-nonce") {
          if (phase === "wrong-nonce") {
            await expect(
              manager.processEvent({
                id: "evt-pending-wrong-nonce",
                type: "call.speech",
                callId: started.callId,
                providerCallId: "request-uuid",
                timestamp: Date.now(),
                transcript: "stale answer",
                isFinal: true,
                turnToken: "wrong-token",
              }),
            ).resolves.toEqual({ kind: "ignored" });
          }
          const speech = {
            id: `evt-${phase}-speech`,
            type: "call.speech" as const,
            callId: started.callId,
            providerCallId: "request-uuid",
            timestamp: Date.now(),
            transcript: "first exact answer",
            isFinal: true,
            turnToken,
          };
          await expect(manager.processEvent(speech)).resolves.toMatchObject({
            kind: "final-speech",
            transcript: "first exact answer",
            waiterResolved: true,
          });
          await expect(manager.processEvent(speech)).resolves.toEqual({ kind: "ignored" });
          release.resolve();
          await expect(turn).resolves.toEqual({ success: true, transcript: "first exact answer" });
          const call = expectDefined(manager.getCall(started.callId), "continued fixture call");
          expect(call.transcript.map((entry) => entry.text)).toEqual([
            "Pending question",
            "first exact answer",
          ]);
          expect(provider.stopListeningCalls).toHaveLength(1);
        } else if (phase === "setup-failure") {
          release.resolve();
          await expect(turn).resolves.toEqual({
            success: false,
            error: "synthetic listening setup failed",
          });
          expect(provider.stopListeningCalls).toHaveLength(0);
        } else if (phase === "call-ended") {
          await manager.processEvent(endedEvent);
          release.resolve();
          await expect(turn).resolves.toEqual({ success: false, error: "Call has ended" });
          expect(provider.stopListeningCalls).toHaveLength(0);
        } else {
          // Admit fixture retirement before stop closes public event admission.
          // Its queued work runs after stop synchronously rejects pending waiters.
          retirement = manager.processEvent(endedEvent);
          stopping = manager.stop();
          void stopping.catch(() => {});
          await retirement;
          release.resolve();
          await expect(turn).resolves.toEqual({
            success: false,
            error: "Voice Call manager is stopping",
          });
          await stopping;
          expect(provider.stopListeningCalls).toHaveLength(0);
        }
        expect(provider.startListeningCalls).toHaveLength(1);
        expect(transient.transcriptWaiters.has(started.callId)).toBe(false);
        expect(transient.activeTurnCalls.has(started.callId)).toBe(false);
      } finally {
        try {
          if (!stopping && manager.getCall(started.callId)) {
            await manager.processEvent(endedEvent);
          }
        } finally {
          release.resolve();
          await Promise.allSettled(
            [turn, retirement, stopping].filter((work) => work !== undefined),
          );
          listening.mockRestore();
        }
      }
    },
  );

  it("rejects overlapping continueCall requests for the same call", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-overlap-answered");

    const first = manager.continueCall(started.callId, "First prompt");
    const second = await manager.continueCall(started.callId, "Second prompt");
    expect(second.success).toBe(false);
    expect(second.error).toBe("Already waiting for transcript");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    await manager.processEvent({
      id: "evt-overlap-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Done",
      isFinal: true,
    });

    const firstResult = await first;
    expect(firstResult.success).toBe(true);
    expect(firstResult.transcript).toBe("Done");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);
  });

  it("ignores speech events with mismatched turnToken while waiting for transcript", async () => {
    const { manager, provider } = await createManagerHarness(
      {
        transcriptTimeoutMs: 5000,
      },
      new FakeProvider("twilio"),
    );

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-turn-token-answered");

    const turnPromise = manager.continueCall(started.callId, "Prompt");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    const expectedTurnToken = requireTurnToken(provider);

    const staleResult = await manager.processEvent({
      id: "evt-turn-token-bad",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "stale replay",
      isFinal: true,
      turnToken: "wrong-token",
    });
    expect(staleResult).toEqual({ kind: "ignored" });

    expectTranscriptWaiter(manager, started.callId);

    const finalResult = await manager.processEvent({
      id: "evt-turn-token-good",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "final answer",
      isFinal: true,
      turnToken: expectedTurnToken,
    });
    expect(finalResult).toMatchObject({
      kind: "final-speech",
      transcript: "final answer",
      waiterResolved: true,
    });

    const turnResult = await turnPromise;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("final answer");

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual(["Prompt", "final answer"]);
  });

  it("tracks latency metadata across multiple closed-loop turns", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000005");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-multi-answered");

    const firstTurn = manager.continueCall(started.callId, "First question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-1",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "First answer",
      isFinal: true,
    });
    await firstTurn;

    const secondTurn = manager.continueCall(started.callId, "Second question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(2);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-2",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Second answer",
      isFinal: true,
    });
    const secondResult = await secondTurn;

    expect(secondResult.success).toBe(true);

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(2);
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(provider.startListeningCalls).toHaveLength(2);
    expect(provider.stopListeningCalls).toHaveLength(2);
  });
});
