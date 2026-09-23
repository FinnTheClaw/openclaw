import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { handlePreviewFinalizedResult } from "./bot-message-dispatch-delivery.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery-text-deliverer.js";
import { createTelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";

function setup(streamed = true) {
  const answerStream = createTestDraftStream({ messageId: 999 });
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answerStream,
      lastPartialText: "",
      hasStreamedMessage: streamed,
      finalized: false,
      retainedPromptContextPages: [],
    },
    reasoning: {
      stream: undefined,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      retainedPromptContextPages: [],
    },
  };
  const sendPayload = vi.fn<(payload: ReplyPayload) => Promise<boolean>>().mockResolvedValue(true);
  const deliver = createLaneTextDeliverer({
    lanes,
    applyTextToPayload: (payload, text) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane: async (lane) => {
      await lane.stream?.flush();
    },
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
    clearDraftLane: async (lane) => {
      await lane.stream?.clear();
    },
    editStreamMessage: vi.fn().mockResolvedValue(undefined),
    createPromptContextSequence: () =>
      createTelegramPromptContextProjectionSequence({ record: async () => true }),
    log: vi.fn(),
    markDelivered: vi.fn(),
  });
  return { deliver, sendPayload, answerStream };
}

const finalMedia = (
  harness: ReturnType<typeof setup>,
  payload: ReplyPayload = {
    text: "photo",
    mediaUrl: "https://example.com/a.png",
  },
  options?: { durable?: boolean },
) =>
  harness.deliver({
    laneName: "answer",
    text: "photo",
    payload,
    infoKind: "final",
    ...options,
  });

function expectPartial(result: LaneDeliveryResult) {
  expect(result.kind).toBe("preview-finalized-partial");
  if (result.kind !== "preview-finalized-partial") {
    throw new Error(`expected partial, got ${result.kind}`);
  }
  return result;
}

describe("TELEGRAM-LANE-DELIVERY-01 ten-case production-component pack", () => {
  it("TELEGRAM-LANE-DELIVERY-01-C01 successful late media finalizes", async () => {
    const h = setup();
    expect((await finalMedia(h)).kind).toBe("preview-finalized");
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
  });
  it("TELEGRAM-LANE-DELIVERY-01-C02 false late media is partial", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    expectPartial(await finalMedia(h));
  });
  it("TELEGRAM-LANE-DELIVERY-01-C03 thrown late media is partial", async () => {
    const h = setup();
    h.sendPayload.mockRejectedValueOnce(new Error("rejected"));
    expectPartial(await finalMedia(h));
  });
  it("TELEGRAM-LANE-DELIVERY-01-C04 text-only final needs no media send", async () => {
    const h = setup();
    const result = await h.deliver({
      laneName: "answer",
      text: "photo",
      payload: { text: "photo" },
      infoKind: "final",
    });
    expect(result.kind).toBe("preview-finalized");
    expect(h.sendPayload).not.toHaveBeenCalled();
  });
  it("TELEGRAM-LANE-DELIVERY-01-C05 false preserves concrete preview receipt", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    const result = expectPartial(
      await finalMedia(h, {
        text: "spoken caption",
        mediaUrl: "https://example.com/voice.ogg",
        audioAsVoice: true,
      }),
    );
    expect(result.delivery.receipt.primaryPlatformMessageId).toBe("999");
    expect(result.delivery.content).toBe("photo");
    expect(h.sendPayload.mock.calls[0]?.[0]).toMatchObject({
      mediaUrl: "https://example.com/voice.ogg",
      audioAsVoice: true,
    });
  });
  it("TELEGRAM-LANE-DELIVERY-01-C06 false carries an actual failure", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    const result = expectPartial(
      await finalMedia(h, {
        text: "attached report",
        mediaUrl: "file:///workspace/campaign/report.pdf",
      }),
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain("late media");
    expect(h.sendPayload.mock.calls[0]?.[0]).toMatchObject({
      mediaUrl: "file:///workspace/campaign/report.pdf",
    });
  });
  it("TELEGRAM-LANE-DELIVERY-01-C07 false never duplicates fallback", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    expectPartial(
      await h.deliver({
        laneName: "answer",
        text: "photo with button",
        payload: { text: "photo with button", mediaUrl: "https://example.com/button.png" },
        infoKind: "final",
        buttons: [[{ text: "Open", callback_data: "open" }]],
      }),
    );
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect(h.sendPayload.mock.calls[0]?.[0]).toMatchObject({
      mediaUrl: "https://example.com/button.png",
    });
    expect(h.answerStream.clear).not.toHaveBeenCalled();
  });
  it("TELEGRAM-LANE-DELIVERY-01-C08 mediaUrls false also reports partial", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    expectPartial(
      await finalMedia(h, {
        text: "photo",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      }),
    );
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
  });
  it("TELEGRAM-LANE-DELIVERY-01-C09 non-durable finalized preview stays truthful", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    expectPartial(await finalMedia(h, undefined, { durable: false }));
  });
  it("TELEGRAM-LANE-DELIVERY-01-C10 caller surfaces partial without fallback", async () => {
    const h = setup();
    h.sendPayload.mockResolvedValueOnce(false);
    const result = expectPartial(await finalMedia(h));
    const emit = vi.fn();
    const mark = vi.fn();
    const turn = {
      isSuperseded: () => false,
      telegramDeps: { emitTelegramMessageSentHooks: emit },
      context: { chatId: 42, route: { accountId: "default" }, ctxPayload: {}, isGroup: false },
      progressCompositor: { markFinalReplyDelivered: mark },
    } as unknown as Parameters<typeof handlePreviewFinalizedResult>[0];
    await expect(handlePreviewFinalizedResult(turn, result)).rejects.toThrow();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ success: false, messageId: 999 }));
    expect(mark).toHaveBeenCalledTimes(1);
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
  });
});
