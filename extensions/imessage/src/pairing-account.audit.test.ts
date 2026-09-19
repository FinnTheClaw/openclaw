import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "synthetic-guid", sentText: "approved" })),
);
vi.mock("./send.js", () => ({ sendMessageIMessage: send }));
const { imessagePlugin } = await import("./channel.js");
describe("iMessage pairing account routing", () => {
  it("notifies the requesting non-default account", async () => {
    const cfg = {
      channels: {
        imessage: {
          defaultAccount: "default",
          accounts: {
            default: { cliPath: "/synthetic/default/imsg", dbPath: "/synthetic/default/chat.db" },
            work: { cliPath: "/synthetic/work/imsg", dbPath: "/synthetic/work/chat.db" },
          },
        },
      },
    } as OpenClawConfig;
    await imessagePlugin.pairing!.notifyApproval!({
      cfg,
      id: "synthetic@example.test",
      accountId: "work",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "synthetic@example.test",
      expect.any(String),
      expect.objectContaining({ config: cfg, accountId: "work" }),
    );
  });
});
