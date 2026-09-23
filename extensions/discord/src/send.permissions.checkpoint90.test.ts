import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "./internal/discord.js";
import { fetchChannelPermissionsDiscord } from "./send.permissions.js";
import { EMPTY_DISCORD_TEST_OPTS } from "./test-support/config.js";

const rest = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client.js", () => ({
  resolveDiscordRest: () => rest as unknown as RequestClient,
}));

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
type Scenario = {
  name: string;
  thread?: boolean;
  privateThread?: boolean;
  everyoneBits?: bigint;
  roleBits?: bigint;
  everyoneDeny?: bigint;
  roleAllow?: bigint;
  memberDeny?: bigint;
  expectedView: boolean;
  expectedSend?: boolean;
  parentFailure?: boolean;
  dm?: boolean;
};

const cases: Scenario[] = [
  { name: "P01 ordinary allow", everyoneBits: VIEW | SEND, expectedView: true, expectedSend: true },
  {
    name: "P02 ordinary everyone deny",
    everyoneBits: VIEW,
    everyoneDeny: VIEW,
    expectedView: false,
  },
  {
    name: "P03 parent everyone deny",
    thread: true,
    everyoneBits: VIEW,
    everyoneDeny: VIEW,
    expectedView: false,
  },
  { name: "P04 parent role allow", thread: true, roleAllow: VIEW, expectedView: true },
  {
    name: "P05 parent member deny",
    thread: true,
    everyoneBits: VIEW,
    memberDeny: VIEW,
    expectedView: false,
  },
  {
    name: "P06 private thread parent allow",
    thread: true,
    privateThread: true,
    everyoneBits: VIEW,
    expectedView: true,
  },
  {
    name: "P07 private thread parent deny",
    thread: true,
    privateThread: true,
    everyoneBits: VIEW,
    everyoneDeny: VIEW,
    expectedView: false,
  },
  {
    name: "P08 public thread parent allow",
    thread: true,
    everyoneBits: VIEW | SEND,
    expectedView: true,
    expectedSend: true,
  },
  { name: "P09 DM unchanged", dm: true, expectedView: false },
  {
    name: "P10 parent-fetch failure propagated",
    thread: true,
    parentFailure: true,
    expectedView: false,
  },
];

describe("CH01 Discord thread permission summaries", () => {
  beforeEach(() => rest.get.mockReset());

  it.each(cases)("$name", async (scenario) => {
    const overwrites = [
      scenario.everyoneDeny
        ? { id: "guild-1", deny: scenario.everyoneDeny.toString(), allow: "0", type: 0 }
        : undefined,
      scenario.roleAllow
        ? { id: "role-1", deny: "0", allow: scenario.roleAllow.toString(), type: 0 }
        : undefined,
      scenario.memberDeny
        ? { id: "bot-1", deny: scenario.memberDeny.toString(), allow: "0", type: 1 }
        : undefined,
    ].filter(Boolean);
    const requested = {
      id: "thread-1",
      ...(scenario.dm ? {} : { guild_id: "guild-1" }),
      type: scenario.thread
        ? scenario.privateThread
          ? ChannelType.PrivateThread
          : ChannelType.PublicThread
        : scenario.dm
          ? ChannelType.DM
          : ChannelType.GuildText,
      ...(scenario.thread ? { parent_id: "parent-1" } : {}),
      permission_overwrites: scenario.thread ? [] : overwrites,
    };
    const parent = {
      id: "parent-1",
      guild_id: "guild-1",
      type: ChannelType.GuildText,
      permission_overwrites: overwrites,
    };
    rest.get.mockResolvedValueOnce(requested);
    if (!scenario.dm) {
      rest.get.mockResolvedValueOnce({ id: "bot-1" });
      rest.get.mockResolvedValueOnce({
        id: "guild-1",
        owner_id: "owner-1",
        roles: [
          { id: "guild-1", permissions: String(scenario.everyoneBits ?? 0n) },
          { id: "role-1", permissions: String(scenario.roleBits ?? 0n) },
        ],
      });
      rest.get.mockResolvedValueOnce({ roles: ["role-1"] });
      if (scenario.thread) {
        if (scenario.parentFailure) {
          rest.get.mockRejectedValueOnce(new Error("parent unavailable"));
        } else {
          rest.get.mockResolvedValueOnce(parent);
        }
      }
    }
    if (scenario.parentFailure) {
      await expect(
        fetchChannelPermissionsDiscord("thread-1", EMPTY_DISCORD_TEST_OPTS),
      ).rejects.toThrow("parent unavailable");
      return;
    }
    const summary = await fetchChannelPermissionsDiscord("thread-1", EMPTY_DISCORD_TEST_OPTS);
    expect(summary.channelId).toBe("thread-1");
    expect(summary.channelType).toBe(requested.type);
    expect(summary.isDm).toBe(Boolean(scenario.dm));
    expect(summary.permissions.includes("ViewChannel")).toBe(scenario.expectedView);
    if (scenario.expectedSend !== undefined) {
      expect(summary.permissions.includes("SendMessages")).toBe(scenario.expectedSend);
    }
    expect(rest.get).toHaveBeenCalledTimes(scenario.dm ? 1 : scenario.thread ? 5 : 4);
  });
});
