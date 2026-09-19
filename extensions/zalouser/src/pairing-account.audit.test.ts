import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ok: true, messageId: "synthetic-zalo-message" })),
  authenticated: vi.fn(async () => true),
}));
vi.mock("./channel.runtime.js", () => ({ sendMessageZalouser: mocks.send }));
vi.mock("./accounts.runtime.js", () => ({ checkZaloAuthenticated: mocks.authenticated }));
const { zalouserPlugin } = await import("./channel.js");

describe("Zalouser pairing account routing", () => {
  it("authenticates and sends with the requesting profile", async () => {
    const cfg = {
      channels: {
        zalouser: {
          defaultAccount: "default",
          accounts: {
            default: { profile: "synthetic-default-profile" },
            work: { profile: "synthetic-work-profile" },
          },
        },
      },
    } as OpenClawConfig;
    await zalouserPlugin.pairing!.notifyApproval!({ cfg, id: "42", accountId: "work" });
    expect
      .soft(mocks.authenticated)
      .toHaveBeenCalledExactlyOnceWith("synthetic-work-profile", undefined);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("42", expect.any(String), {
      profile: "synthetic-work-profile",
    });
  });
});
