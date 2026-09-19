import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

describe("LINE pairing account routing", () => {
  it("selects the requesting account and its token", async () => {
    const pushMessageLine = vi.fn(async () => ({ messageId: "synthetic-line-message" }));
    setLineRuntime({ channel: { line: { pushMessageLine } } } as unknown as Parameters<
      typeof setLineRuntime
    >[0]);
    const cfg = {
      channels: {
        line: {
          defaultAccount: "default",
          accounts: {
            default: {
              channelAccessToken: "synthetic-default-token",
              channelSecret: "synthetic-default-secret",
            },
            work: {
              channelAccessToken: "synthetic-work-token",
              channelSecret: "synthetic-work-secret",
            },
          },
        },
      },
    } as OpenClawConfig;
    await linePlugin.pairing!.notifyApproval!({
      cfg,
      id: "U11111111111111111111111111111111",
      accountId: "work",
    });
    expect(pushMessageLine).toHaveBeenCalledExactlyOnceWith(
      "U11111111111111111111111111111111",
      expect.any(String),
      expect.objectContaining({
        cfg,
        accountId: "work",
        channelAccessToken: "synthetic-work-token",
      }),
    );
  });
});
