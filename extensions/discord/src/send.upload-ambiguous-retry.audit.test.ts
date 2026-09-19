import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordWebMediaMockFactory, makeDiscordRest, requestBody } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", () => discordWebMediaMockFactory());
const { sendMessageDiscord } = await import("./send.js");

describe("Discord multipart retry fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not replace an ambiguously accepted upload with a new-nonce text send", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rejected = Object.assign(new Error("upload rejected"), { status: 413 });
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("response lost"), { status: 502 }))
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ id: "duplicate-text", channel_id: "789" });
    await expect(
      sendMessageDiscord("channel:789", "report", {
        cfg: { channels: { discord: { token: "synthetic-token" } } },
        token: "synthetic-token",
        rest,
        mediaUrl: "file:///tmp/synthetic-report.jpg",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toBe(rejected);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestBody(postMock, 1).nonce).toBe(requestBody(postMock, 0).nonce);
  });

  it("keeps same-nonce retries when the upload is subsequently acknowledged", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("response lost"), { status: 502 }))
      .mockResolvedValueOnce({ id: "accepted-upload", channel_id: "789" });
    const result = await sendMessageDiscord("channel:789", "report", {
      cfg: { channels: { discord: { token: "synthetic-token" } } },
      token: "synthetic-token",
      rest,
      mediaUrl: "file:///tmp/synthetic-report.jpg",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    expect(result.messageId).toBe("accepted-upload");
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestBody(postMock, 1).nonce).toBe(requestBody(postMock, 0).nonce);
  });

  it("retains text fallback after a pre-connect retry and definitive upload rejection", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      )
      .mockRejectedValueOnce(Object.assign(new Error("upload rejected"), { status: 413 }))
      .mockResolvedValueOnce({ id: "fallback-text", channel_id: "789" });
    const result = await sendMessageDiscord("channel:789", "report", {
      cfg: { channels: { discord: { token: "synthetic-token" } } },
      token: "synthetic-token",
      rest,
      mediaUrl: "file:///tmp/synthetic-report.jpg",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    expect(result.messageId).toBe("fallback-text");
    expect(postMock).toHaveBeenCalledTimes(3);
    expect(requestBody(postMock, 1).nonce).toBe(requestBody(postMock, 0).nonce);
    expect(requestBody(postMock, 2)).not.toHaveProperty("files");
    expect(requestBody(postMock, 2).nonce).not.toBe(requestBody(postMock, 0).nonce);
  });
});
