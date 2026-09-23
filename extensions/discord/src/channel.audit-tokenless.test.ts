import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordAccount } from "./accounts.js";
import { discordPlugin } from "./channel.js";

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("./channel.loaders.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel.loaders.js")>();
  return {
    ...actual,
    loadDiscordAuditModule: async () => ({
      ...(await import("./audit.js")),
      auditDiscordChannelPermissions: auditMock,
    }),
  };
});

function config(channels: Record<string, { allow: boolean }>, token?: string): OpenClawConfig {
  return {
    channels: { discord: { enabled: true, token, guilds: { "999": { channels } } } },
  } as unknown as OpenClawConfig;
}

async function runAudit(cfg: OpenClawConfig, accountId = "default", token?: string) {
  const account = { ...resolveDiscordAccount({ cfg, accountId }), token };
  return await discordPlugin.status?.auditAccount?.({ account, cfg, timeoutMs: 100 });
}

describe("Discord configured-channel audit without credentials", () => {
  beforeEach(() => auditMock.mockReset());

  it("D01 returns no audit when no channel is configured", async () => {
    expect(await runAudit(config({}))).toBeUndefined();
  });
  it("D02 fails for one numeric channel without a token", async () => {
    expect(await runAudit(config({ "123": { allow: true } }))).toMatchObject({
      ok: false,
      checkedChannels: 0,
      unresolvedChannels: 0,
    });
  });
  it("D03 fails for multiple numeric channels without a token", async () => {
    expect(
      await runAudit(config({ "123": { allow: true }, "456": { allow: true } })),
    ).toMatchObject({ ok: false, checkedChannels: 0, unresolvedChannels: 0 });
  });
  it("D04 treats a whitespace token as missing", async () => {
    expect(await runAudit(config({ "123": { allow: true } }), "default", "  ")).toMatchObject({
      ok: false,
      checkedChannels: 0,
    });
  });
  it("D05 fails for unresolved channel name without a token", async () => {
    expect(await runAudit(config({ general: { allow: true } }))).toMatchObject({
      ok: false,
      checkedChannels: 0,
      unresolvedChannels: 1,
    });
  });
  it("D06 fails for mixed numeric and unresolved channels without a token", async () => {
    expect(
      await runAudit(config({ "123": { allow: true }, general: { allow: true } })),
    ).toMatchObject({ ok: false, checkedChannels: 0, unresolvedChannels: 1 });
  });
  it("D07 preserves a successful authenticated audit", async () => {
    auditMock.mockResolvedValueOnce({ ok: true, checkedChannels: 1, channels: [], elapsedMs: 1 });
    expect(await runAudit(config({ "123": { allow: true } }), "default", "token")).toMatchObject({
      ok: true,
      checkedChannels: 1,
      unresolvedChannels: 0,
    });
  });
  it("D08 preserves a missing-permission audit failure", async () => {
    auditMock.mockResolvedValueOnce({
      ok: false,
      checkedChannels: 1,
      channels: [{ channelId: "123", ok: false, missing: ["SendMessages"] }],
      elapsedMs: 1,
    });
    expect(await runAudit(config({ "123": { allow: true } }), "default", "token")).toMatchObject({
      ok: false,
      checkedChannels: 1,
    });
  });
  it("D09 preserves an authenticated audit error", async () => {
    auditMock.mockRejectedValueOnce(new Error("permission audit timed out"));
    await expect(runAudit(config({ "123": { allow: true } }), "default", "token")).rejects.toThrow(
      "permission audit timed out",
    );
  });
  it("D10 keeps account A tokenless despite account B having a token", async () => {
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            a: { guilds: { "999": { channels: { "123": { allow: true } } } } },
            b: { token: "token-b", guilds: { "999": { channels: { "456": { allow: true } } } } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(await runAudit(cfg, "a")).toMatchObject({ ok: false, checkedChannels: 0 });
    expect(auditMock).not.toHaveBeenCalled();
  });
});
