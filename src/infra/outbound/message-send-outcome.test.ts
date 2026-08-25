import { describe, expect, it } from "vitest";
import {
  areMessageBroadcastEntriesSuccessful,
  isMessageSendSuccessful,
  resolveMessageSendOutcome,
} from "./message-send-outcome.js";
import type { MessageSendResult } from "./message.js";

function messageSendResult(overrides: Partial<MessageSendResult> = {}): MessageSendResult {
  return {
    channel: "forum",
    to: "123456",
    via: "direct",
    mediaUrl: null,
    ...overrides,
  };
}

describe("resolveMessageSendOutcome", () => {
  it("accepts sent and legacy success results", () => {
    expect(resolveMessageSendOutcome(messageSendResult({ deliveryStatus: "sent" }))).toEqual({
      ok: true,
    });
    expect(resolveMessageSendOutcome(undefined)).toEqual({ ok: true });
    expect(resolveMessageSendOutcome(messageSendResult())).toEqual({ ok: true });
  });

  it("reports suppressed sends with exact and fallback reasons", () => {
    expect(
      resolveMessageSendOutcome(
        messageSendResult({
          deliveryStatus: "suppressed",
          suppressionReason: "cancelled_by_message_sending_hook",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "Message send suppressed: cancelled_by_message_sending_hook.",
    });
    expect(
      resolveMessageSendOutcome(messageSendResult({ deliveryStatus: "suppressed" }), "Broadcast"),
    ).toEqual({ ok: false, error: "Broadcast send suppressed: unknown reason." });
  });

  it("reports failed sends with exact and fallback errors", () => {
    expect(
      resolveMessageSendOutcome(
        messageSendResult({ deliveryStatus: "failed", error: "transport unavailable" }),
      ),
    ).toEqual({ ok: false, error: "transport unavailable" });
    expect(
      resolveMessageSendOutcome(messageSendResult({ deliveryStatus: "failed" }), "Broadcast"),
    ).toEqual({ ok: false, error: "Broadcast send failed." });
  });

  it("reports partial sends with exact and fallback errors plus partial-send metadata", () => {
    expect(
      resolveMessageSendOutcome(
        messageSendResult({ deliveryStatus: "partial_failed", error: "chunk 2 rejected" }),
      ),
    ).toEqual({ ok: false, error: "chunk 2 rejected", sentBeforeError: true });
    expect(
      resolveMessageSendOutcome(
        messageSendResult({ deliveryStatus: "partial_failed" }),
        "Broadcast",
      ),
    ).toEqual({
      ok: false,
      error: "Broadcast send partially failed.",
      sentBeforeError: true,
    });
  });
});

describe("message send success predicates", () => {
  it("treats dry-run sends as successful without masking live failures", () => {
    const failed = messageSendResult({ deliveryStatus: "failed" });

    expect(isMessageSendSuccessful(failed)).toBe(false);
    expect(isMessageSendSuccessful(failed, true)).toBe(true);
  });

  it("requires every broadcast entry to succeed", () => {
    expect(areMessageBroadcastEntriesSuccessful([{ ok: true }, { ok: true }])).toBe(true);
    expect(areMessageBroadcastEntriesSuccessful([{ ok: true }, { ok: false }])).toBe(false);
  });
});
