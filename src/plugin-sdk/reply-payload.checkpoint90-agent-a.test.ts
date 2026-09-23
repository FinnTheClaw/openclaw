import { describe, expect, it, vi } from "vitest";
import { deliverTextOrMediaReply, sendMediaWithLeadingCaption } from "./reply-payload.js";

describe("checkpoint 90 all-media-fail fallback", () => {
  it("zero-media-text", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendMedia = vi.fn(async () => undefined);
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello" },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).toBe("text");
    expect(sendText).toHaveBeenCalledExactlyOnceWith("hello");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("one-media-success", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendMedia = vi.fn(async () => undefined);
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a"] },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).toBe("media");
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("one-media-failure-with-handler", async () => {
    const sendText = vi.fn(async () => undefined);
    const onMediaError = vi.fn();
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a"] },
        text: "hello",
        sendText,
        sendMedia: async () => {
          throw new Error("offline");
        },
        onMediaError,
      }),
    ).toBe("text");
    expect(onMediaError).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("two-media-all-fail-with-handler", async () => {
    const sendText = vi.fn(async () => undefined);
    const onMediaError = vi.fn();
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia: async () => {
          throw new Error("offline");
        },
        onMediaError,
      }),
    ).toBe("text");
    expect(onMediaError).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("first-fail-second-success", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia,
        onMediaError: () => undefined,
      }),
    ).toBe("media");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("first-success-second-fail", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia,
        onMediaError: () => undefined,
      }),
    ).toBe("media");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("failure-no-handler-throws", async () => {
    const sendText = vi.fn(async () => undefined);
    await expect(
      deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a"] },
        text: "hello",
        sendText,
        sendMedia: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("blank-text-all-media-fail", async () => {
    const sendText = vi.fn(async () => undefined);
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "", mediaUrls: ["https://a"] },
        text: "",
        sendText,
        sendMedia: async () => {
          throw new Error("offline");
        },
        onMediaError: () => undefined,
      }),
    ).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("caption-first-only", async () => {
    const send = vi.fn(async () => undefined);
    expect(
      await sendMediaWithLeadingCaption({
        mediaUrls: ["https://a", "https://b"],
        caption: "hello",
        send,
      }),
    ).toBe(true);
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      { mediaUrl: "https://a", caption: "hello" },
      { mediaUrl: "https://b", caption: undefined },
    ]);
  });

  it("text-chunk-fallback-on-all-fail", async () => {
    const sendText = vi.fn(async () => undefined);
    expect(
      await deliverTextOrMediaReply({
        payload: { text: "alpha beta", mediaUrls: ["https://a"] },
        text: "alpha beta",
        chunkText: () => ["alpha", "beta"],
        sendText,
        sendMedia: async () => {
          throw new Error("offline");
        },
        onMediaError: () => undefined,
      }),
    ).toBe("text");
    expect(sendText.mock.calls.map((call) => call[0])).toEqual(["alpha", "beta"]);
  });
});
