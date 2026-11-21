import { describe, expect, it } from "vitest";
import { getAccountConfig, resolveTwitchAccountContext } from "./config.js";
import { makeTwitchChannelTestConfig } from "./test-fixtures.js";

describe("getAccountConfig", () => {
  it("normalizes account ids without reading inherited account properties", () => {
    const accounts = Object.create({
      inherited: {
        username: "inherited-bot",
        accessToken: "oauth:inherited",
      },
    }) as Record<string, unknown>;
    accounts.Secondary = {
      username: "secondbot",
      accessToken: "oauth:secondary",
    };

    const cfg = makeTwitchChannelTestConfig({
      accounts,
    });

    expect(getAccountConfig(cfg, "SECONDARY\r\n")).toEqual({
      username: "secondbot",
      accessToken: "oauth:secondary",
    });
    expect(getAccountConfig(cfg, "inherited")).toBeNull();
  });

  it("returns null when core config is null", () => {
    const result = getAccountConfig(null, "default");

    expect(result).toBeNull();
  });
});

describe("resolveTwitchAccountContext", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const context = resolveTwitchAccountContext(
      makeTwitchChannelTestConfig({
        defaultAccount: "secondary",
        accounts: {
          default: {
            username: "default-bot",
            accessToken: "oauth:default-token",
          },
          secondary: {
            username: "second-bot",
            accessToken: "oauth:second-token",
          },
        },
      }) as Parameters<typeof resolveTwitchAccountContext>[0],
    );

    expect(context.accountId).toBe("secondary");
    expect(context.account?.username).toBe("second-bot");
  });
});

describe("default account sparse root override", () => {
  const account = {
    username: "account-bot",
    accessToken: "oauth:account",
    clientId: "account-client",
    channel: "#account",
    enabled: true,
    allowFrom: ["account-user"],
    allowedRoles: ["mod"],
    requireMention: true,
    clientSecret: "account-secret",
  };

  it.each([
    ["inherits username when root omits it", {}, "username", "account-bot"],
    ["inherits accessToken when root omits it", {}, "accessToken", "oauth:account"],
    ["inherits clientId when root omits it", {}, "clientId", "account-client"],
    ["inherits channel when root omits it", {}, "channel", "#account"],
    ["keeps an explicit false enabled override", { enabled: false }, "enabled", false],
    ["keeps an explicit empty allowFrom override", { allowFrom: [] }, "allowFrom", []],
    ["keeps an explicit empty allowedRoles override", { allowedRoles: [] }, "allowedRoles", []],
    [
      "keeps an explicit false requireMention override",
      { requireMention: false },
      "requireMention",
      false,
    ],
    ["keeps an explicit empty username override", { username: "" }, "username", ""],
    ["keeps an explicit empty clientSecret override", { clientSecret: "" }, "clientSecret", ""],
  ])("%s", (_name, rootFields, field, expected) => {
    const result = getAccountConfig(
      {
        channels: {
          twitch: {
            accounts: { default: account },
            ...rootFields,
          },
        },
      },
      "default",
    ) as Record<string, unknown> | null;
    expect(result?.[field as string]).toEqual(expected);
  });
});
