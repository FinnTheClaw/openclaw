import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn(async () => ({ messageId: "synthetic-irc-message" })));
vi.mock("./channel-runtime.js", () => ({ sendMessageIrc: send }));
const { ircPlugin } = await import("./channel.js");

describe("IRC pairing account routing", () => {
  it("preserves the requesting account for a network-local nickname", async () => {
    const cfg = {
      channels: {
        irc: {
          accounts: {
            default: { host: "default.test", nick: "default-bot" },
            work: { host: "work.test", nick: "work-bot" },
          },
        },
      },
    } as OpenClawConfig;
    await ircPlugin.pairing!.notifyApproval!({
      cfg,
      id: "alice!user@synthetic.test",
      accountId: "work",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "alice",
      expect.any(String),
      expect.objectContaining({ cfg, accountId: "work" }),
    );
  });
});
