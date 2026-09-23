import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recoverStore } from "./main-session-recovery/main-session-restart-recovery-store.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";

type DeliveryState = "delivered" | "suppressed" | "unknown";

const cases: Array<{
  id: string;
  payloads: ReplyPayload[];
  attempted: string[];
  states: DeliveryState[];
  suppressFirst?: boolean;
  failFirst?: boolean;
  delayFirst?: boolean;
}> = [
  {
    id: "F01 Two-text",
    payloads: [{ text: "one" }, { text: "two" }],
    attempted: ["one", "two"],
    states: ["delivered", "delivered"],
  },
  {
    id: "F03 Text-then-media",
    payloads: [{ text: "one" }, { mediaUrl: "https://example.test/a.png" }],
    attempted: ["one", "https://example.test/a.png"],
    states: ["delivered", "delivered"],
  },
  {
    id: "F04 Media-then-text",
    payloads: [{ mediaUrl: "https://example.test/a.png" }, { text: "two" }],
    attempted: ["https://example.test/a.png", "two"],
    states: ["delivered", "delivered"],
  },
  {
    id: "F05 Two-media",
    payloads: [
      { mediaUrl: "https://example.test/a.png" },
      { mediaUrl: "https://example.test/b.png" },
    ],
    attempted: ["https://example.test/a.png", "https://example.test/b.png"],
    states: ["delivered", "delivered"],
  },
  {
    id: "F06 First-suppressed",
    payloads: [{ text: "one" }, { text: "two" }],
    attempted: ["two"],
    states: ["suppressed", "delivered"],
    suppressFirst: true,
  },
  {
    id: "F07 First-send-error",
    payloads: [{ text: "one" }, { text: "two" }],
    attempted: ["one", "two"],
    states: ["unknown", "delivered"],
    failFirst: true,
  },
  {
    id: "F08 Delayed-first",
    payloads: [{ text: "one" }, { text: "two" }],
    attempted: ["one", "two"],
    states: ["delivered", "delivered"],
    delayFirst: true,
  },
  {
    id: "F09 Single-final-control",
    payloads: [{ text: "one" }],
    attempted: ["one"],
    states: ["delivered"],
  },
  {
    id: "F10 Mixed-empty-control",
    payloads: [{ text: "" }, { text: "one" }, { text: "  " }, { text: "two" }],
    attempted: ["one", "two"],
    states: ["delivered", "delivered"],
  },
];

function label(payload: ReplyPayload): string {
  return payload.text?.trim() || payload.mediaUrl || "";
}

describe("pending final delivery F01-F10 custody pack", () => {
  it.each(cases)(
    "$id",
    async ({ payloads, attempted, states, suppressFirst, failFirst, delayFirst }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-final-custody-"));
      const storePath = path.join(tmpDir, "sessions.json");
      const sessionKey = "agent:main:telegram:direct:123";
      const entry: SessionEntry = {
        sessionId: "session-1",
        status: "running",
        updatedAt: Date.now(),
      };
      let releaseFirst: (() => void) | undefined;
      const firstFinalization = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      try {
        await replaceSessionEntry({ storePath, sessionKey }, entry);
        const result = await persistPendingFinalDeliveryMarker({
          deliver: true,
          sessionStore: { [sessionKey]: entry },
          sessionKey,
          sessionEntry: entry,
          storePath,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads,
          deliveryContext: { channel: "telegram", to: "123" },
          runOwnedSessionId: entry.sessionId,
        });
        expect(result.pendingFinalDeliveryMarkerPersisted).toBe(true);
        const initialDeliveries = result.sessionEntry?.pendingFinalDelivery?.deliveries ?? [];
        expect(initialDeliveries).toHaveLength(states.length);
        expect(initialDeliveries.map(({ state }) => state)).toEqual(states.map(() => "prepared"));
        const metadataIds = payloads
          .map(
            (payload) =>
              getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
          )
          .filter((id): id is string => Boolean(id));
        expect(metadataIds).toEqual(initialDeliveries.map(({ id }) => id));
        expect(new Set(metadataIds).size).toBe(metadataIds.length);

        const attempts: string[] = [];
        const dispatcher = createReplyDispatcher({
          beforeDeliver: suppressFirst
            ? (payload) => (label(payload) === "one" ? null : payload)
            : undefined,
          deliver: async (payload) => {
            const value = label(payload);
            attempts.push(value);
            if (failFirst && value === "one") {
              throw new Error("controlled first-send failure");
            }
            return delayFirst && value === "one" ? { finalization: firstFinalization } : undefined;
          },
        });
        for (const payload of payloads) {
          dispatcher.sendFinalReply(payload);
        }
        dispatcher.markComplete();
        let secondAttemptedBeforeFirstFinalization = false;
        if (delayFirst) {
          try {
            await vi.waitFor(() => expect(attempts).toEqual(["one", "two"]), { timeout: 1000 });
            secondAttemptedBeforeFirstFinalization = true;
          } catch {
            // Preserve the explicit failed assertion after releasing the held first send.
          } finally {
            releaseFirst?.();
          }
        }
        await dispatcher.waitForIdle();
        if (delayFirst) {
          expect(secondAttemptedBeforeFirstFinalization).toBe(true);
        }
        expect(attempts).toEqual(attempted);
        expect(
          loadSessionEntry({ storePath, sessionKey })?.pendingFinalDelivery?.deliveries?.map(
            ({ state }) => state,
          ),
        ).toEqual(states);
      } finally {
        releaseFirst?.();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  it("F02 Partial delivery survives restart without duplicate send", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-final-custody-restart-"));
    const storePath = path.join(tmpDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const entry: SessionEntry = {
      sessionId: "session-f02",
      status: "running",
      updatedAt: Date.now(),
    };
    const payloads: ReplyPayload[] = [{ text: "one" }, { text: "two" }];
    const attempts: string[] = [];
    const dispatchAgent = vi.fn();
    const sendRecoveryNotice = vi.fn();
    const gatewayRuntime = {
      abortAgent: vi.fn(),
      dispatchAgent,
      waitForAgent: vi.fn(),
      sendRecoveryNotice,
    } as unknown as GatewayRecoveryRuntime;
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const persisted = await persistPendingFinalDeliveryMarker({
        deliver: true,
        sessionStore: { [sessionKey]: entry },
        sessionKey,
        sessionEntry: entry,
        storePath,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: { channel: "discord", to: "discord:dm:123" },
        runOwnedSessionId: entry.sessionId,
      });
      expect(persisted.pendingFinalDeliveryMarkerPersisted).toBe(true);
      const pending = persisted.sessionEntry?.pendingFinalDelivery;
      expect(pending?.deliveries).toHaveLength(2);
      const ids = payloads.map(
        (payload) => getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
      );
      expect(ids).toEqual(pending?.deliveries?.map(({ id }) => id));
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          attempts.push(label(payload));
        },
      });
      dispatcher.sendFinalReply(payloads[0]!);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(attempts).toEqual(["one"]);
      const partial = loadSessionEntry({ storePath, sessionKey });
      expect(partial?.pendingFinalDelivery?.deliveries).toEqual([
        { id: ids[0], state: "delivered" },
        { id: ids[1], state: "prepared" },
      ]);
      if (!partial) {
        throw new Error("partial delivery was not persisted");
      }
      await replaceSessionEntry({ storePath, sessionKey }, { ...partial, abortedLastRun: true });
      await expect(
        recoverStore({
          gatewayRuntime,
          handledSessionKeys: new Set(),
          stateDir: tmpDir,
          storePath,
        }),
      ).resolves.toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
      const recovered = loadSessionEntry({ storePath, sessionKey });
      expect(recovered?.status).toBe("done");
      expect(recovered?.pendingFinalDelivery).toBeUndefined();
      expect(recovered?.pendingDeliveryNotice).toMatchObject({
        intentId: pending?.intentId,
        state: "owed",
        context: { channel: "discord", to: "discord:dm:123" },
      });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(attempts).toEqual(["one"]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
