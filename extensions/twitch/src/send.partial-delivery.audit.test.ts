import type { ChatClient } from "@twurple/chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageTwitchInternal } from "./send.js";
import { TwitchClientManager } from "./twitch-client.js";

afterEach(() => vi.restoreAllMocks());

describe("Twitch partial chunk delivery", () => {
  it.each([0, 1, 2])(
    "preserves exactly %i completed chunks and sanitized failure",
    async (completed) => {
      const transportError = Object.assign(new Error("chunk rejected"), {
        transportSecret: "must-not-escape",
      });
      const say = vi.fn();
      for (let i = 0; i < completed; i++) {
        say.mockResolvedValueOnce(undefined);
      }
      say.mockRejectedValueOnce(transportError);
      const manager = new TwitchClientManager({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
      vi.spyOn(manager, "getClient").mockResolvedValue({ say } as unknown as ChatClient);
      const chunk = "a".repeat(500);
      const failure = await sendMessageTwitchInternal({
        channel: "testchannel",
        text: chunk.repeat(completed) + "b",
        cfg: {},
        account: {
          username: "testbot",
          channel: "testchannel",
          clientId: "test-client",
          accessToken: "dummy-test-token",
        },
        accountId: "named",
        clientManager: manager,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty("message", "chunk rejected");
      expect(failure).not.toHaveProperty("transportSecret");
      if (completed === 0) {
        expect(failure).not.toHaveProperty("code");
        expect(failure).not.toHaveProperty("deliveryResult");
        expect(failure).not.toHaveProperty("cause");
      } else {
        expect(failure).toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          sentBeforeError: true,
          deliveryResult: {
            visibleReplySent: true,
            content: Array(completed).fill(chunk).join("\n"),
            messageIds: [expect.any(String)],
            receipt: {
              platformMessageIds: [expect.any(String)],
              parts: [expect.objectContaining({ kind: "text" })],
            },
          },
        });
        expect(failure).toHaveProperty("cause.message", "chunk rejected");
        expect(failure).not.toHaveProperty("cause.transportSecret");
        const result = (
          failure as {
            deliveryResult: { messageIds: string[]; receipt: { platformMessageIds: string[] } };
          }
        ).deliveryResult;
        expect(result.messageIds).toEqual(result.receipt.platformMessageIds);
      }
      expect(say.mock.calls).toEqual([
        ...Array.from({ length: completed }, () => ["testchannel", chunk]),
        ["testchannel", "b"],
      ]);
    },
  );
});
