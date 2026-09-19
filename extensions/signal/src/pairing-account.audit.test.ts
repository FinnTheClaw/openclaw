import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn(async () => ({ messageId: "1700000000778" })));
vi.mock("./send.runtime.js", () => ({ sendMessageSignal: send }));
const { signalPlugin } = await import("./channel.js");
describe("Signal pairing account routing", () => {
  it("notifies the requesting non-default account", async () => {
    const cfg = {
      channels: {
        signal: {
          defaultAccount: "default",
          accounts: {
            default: {
              account: "+15550001111",
              transport: { kind: "external-native", url: "http://default.test" },
            },
            work: {
              account: "+15550002222",
              transport: { kind: "external-native", url: "http://work.test" },
            },
          },
        },
      },
    } as OpenClawConfig;
    await signalPlugin.pairing!.notifyApproval!({ cfg, id: "+15550003333", accountId: "work" });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "+15550003333",
      expect.any(String),
      expect.objectContaining({ cfg, accountId: "work" }),
    );
  });
});
