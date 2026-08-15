import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpc(...args),
}));

const { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } = await import("./send.js");
const { sendReactionSignal } = await import("./send-reactions.js");

function config(protectedTransport: boolean) {
  return {
    channels: {
      signal: {
        accounts: {
          finn: {
            account: "+15550001111",
            httpUrl: "http://signal.invalid",
            ...(protectedTransport
              ? {
                  functionalFinnExternalAuthority: {
                    enabled: true,
                    agentId: "finn",
                    candidateSocketPath: "/private/run/finnrel.sock",
                    ingressSocketPath: "/private/run/finnsig.sock",
                    protectedTransport: true,
                  },
                }
              : {}),
          },
        },
      },
    },
  } as never;
}

describe("Functional Finn protected Signal direct capability fence", () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ timestamp: 123 }));

  it("keeps absent/OFF direct delivery behavior unchanged", async () => {
    await expect(
      sendMessageSignal("+15550002222", "legacy", {
        cfg: config(false),
        accountId: "finn",
      }),
    ).resolves.toMatchObject({ messageId: "123" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("blocks message, typing, receipt, and reaction before any RPC", async () => {
    const cfg = config(true);
    const calls = [
      () => sendMessageSignal("+15550002222", "blocked", { cfg, accountId: "finn" }),
      () => sendTypingSignal("+15550002222", { cfg, accountId: "finn" }),
      () => sendReadReceiptSignal("+15550002222", 123, { cfg, accountId: "finn" }),
      () => sendReactionSignal("+15550002222", 123, "✅", { cfg, accountId: "finn" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(/protected account|external authority/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
