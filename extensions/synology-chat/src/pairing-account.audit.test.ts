import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  sendMessage: send,
}));
const { synologyChatPlugin } = await import("./channel.js");

describe("Synology Chat pairing account routing", () => {
  it("uses the requesting NAS endpoint and TLS setting", async () => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "synthetic-default-token",
          incomingUrl: "https://default.test/incoming",
          allowInsecureSsl: false,
          accounts: {
            work: {
              token: "synthetic-work-token",
              incomingUrl: "https://work.test/incoming",
              allowInsecureSsl: true,
            },
          },
        },
      },
    } as OpenClawConfig;
    await synologyChatPlugin.pairing.notifyApproval!({ cfg, id: "42", accountId: "work" });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "https://work.test/incoming",
      expect.any(String),
      "42",
      true,
    );
  });
});
