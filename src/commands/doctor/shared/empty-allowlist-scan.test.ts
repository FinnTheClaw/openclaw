// Empty allowlist scan tests cover doctor detection of unconfigured sender allowlists.
import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
  resolveDoctorChannelAccountIds: (
    channelName: string,
    cfg: {
      channels?: Record<
        string,
        { accounts?: Record<string, unknown>; appId?: string; baseUrl?: string }
      >;
    },
    configuredAccountIds: string[],
  ) => {
    const channel = cfg.channels?.[channelName];
    const ids = Object.keys(channel?.accounts ?? {});
    const resolveAccountId = (accountId: string) =>
      channelName === "matrix" || channelName === "signal" ? accountId.toLowerCase() : accountId;
    const runtimeIds = [
      ...(channelName === "qa-channel" && channel?.baseUrl ? ["default"] : []),
      ...(channelName === "qqbot" && channel?.appId ? ["default"] : []),
      ...ids,
    ];
    return {
      configured: configuredAccountIds.map(resolveAccountId),
      runtime: runtimeIds.map(resolveAccountId),
    };
  },
}));

vi.mock("./channel-doctor.js", () => ({
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: () => false,
}));

describe("doctor empty allowlist policy scan", () => {
  it("scans top-level and account-scoped channel warnings", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            accounts: {
              work: { dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([
      '- channels.signal.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
      '- channels.signal.accounts.work.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.accounts.work.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
  });

  it("does not warn on empty parent groupAllowFrom when active accounts have effective group allowlists", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              primary: { groupAllowFrom: ["telegram:group:primary"] },
              backup: { allowFrom: ["telegram:group:backup"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("keeps parent groupAllowFrom warning when any active account lacks an effective allowlist", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              primary: { groupAllowFrom: ["telegram:group:primary"] },
              backup: {},
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toContain(
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
    );
  });

  it("keeps parent groupAllowFrom warning when an implicit default account is active", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          "qa-channel": {
            baseUrl: "http://127.0.0.1:18789",
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              work: { groupAllowFrom: ["qa:group:work"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toContain(
      '- channels.qa-channel.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.qa-channel.groupAllowFrom or channels.qa-channel.allowFrom, or set groupPolicy to "open".',
    );
  });

  it("matches canonical runtime account ids to mixed-case config keys", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          matrix: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              Work: { groupAllowFrom: ["matrix:group:work"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("matches raw runtime account ids to canonical config keys", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              Work: { groupAllowFrom: ["signal:group:work"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("keeps parent warning for a distinct case-sensitive implicit default account", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          qqbot: {
            appId: "top-level-app",
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              Default: { groupAllowFrom: ["qqbot:group:named"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toContain(
      '- channels.qqbot.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.qqbot.groupAllowFrom or channels.qqbot.allowFrom, or set groupPolicy to "open".',
    );
  });

  it("allows provider-specific extra warnings without importing providers", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ channelName, prefix }) =>
          channelName === "telegram" ? [`extra:${prefix}`] : [],
      },
    );

    expect(warnings).toStrictEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      "extra:channels.telegram",
    ]);
  });

  it("skips disabled channel and account entries", () => {
    const extraWarningsForAccount = vi.fn(({ prefix }) => [`extra:${prefix}`]);

    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "allowlist",
            accounts: {
              default: { dmPolicy: "allowlist" },
            },
          },
          signal: {
            accounts: {
              disabled: { enabled: false, dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix", extraWarningsForAccount },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
    expect(extraWarningsForAccount).toHaveBeenCalledTimes(1);
    const [warningOptions] = extraWarningsForAccount.mock.calls[0] ?? [];
    expect(warningOptions?.prefix).toBe("channels.signal");
  });
  it.each([
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C01",
      channel: "matrix",
      config: {
        dmPolicy: "open",
        allowFrom: ["@legacy:example.org"],
        dm: { policy: "allowlist", allowFrom: [] },
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.matrix.dm.policy",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C02",
      channel: "matrix",
      config: {
        dmPolicy: "open",
        allowFrom: [],
        dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: ["@alice:example.org"],
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C03",
      channel: "matrix",
      config: {
        dmPolicy: "allowlist",
        allowFrom: [],
        dm: { policy: "open", allowFrom: [] },
      },
      expectedPolicy: "open",
      expectedAllowFrom: [],
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C04",
      channel: "matrix",
      config: {
        dm: { policy: "allowlist" },
        allowFrom: ["@legacy:example.org"],
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: ["@legacy:example.org"],
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C05",
      channel: "matrix",
      config: { dm: { policy: "allowlist", allowFrom: [] } },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.matrix.dm.policy",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C06",
      channel: "matrix",
      config: {
        dmPolicy: "allowlist",
        allowFrom: ["@legacy:example.org"],
        dm: { allowFrom: [] },
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.matrix.dm.policy",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C07",
      channel: "matrix",
      config: {
        dmPolicy: "open",
        allowFrom: [],
        dm: { policy: "allowlist", allowFrom: [] },
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.matrix.dm.policy",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C08",
      channel: "matrix",
      config: {
        dm: { policy: "allowlist", allowFrom: ["@parent:example.org"] },
        accounts: {
          work: { dm: { policy: "allowlist", allowFrom: [] } },
        },
      },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.matrix.accounts.work.dm.policy",
      contextPrefix: "channels.matrix.accounts.work",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C09",
      channel: "matrix",
      config: {
        dm: { policy: "allowlist", allowFrom: ["@parent:example.org"] },
        accounts: {
          work: { dm: { policy: "open", allowFrom: [] } },
        },
      },
      expectedPolicy: "open",
      expectedAllowFrom: [],
      contextPrefix: "channels.matrix.accounts.work",
    },
    {
      id: "DOCTOR-MATRIX-NESTED-ONLY-01/C10",
      channel: "signal",
      config: { dmPolicy: "allowlist", allowFrom: [] },
      expectedPolicy: "allowlist",
      expectedAllowFrom: [],
      expectedWarningPath: "channels.signal.dmPolicy",
    },
  ])("$id uses runtime-effective DM fields", (testCase) => {
    const prefix =
      ("contextPrefix" in testCase && testCase.contextPrefix) || `channels.${testCase.channel}`;
    const warnings = scanEmptyAllowlistPolicyWarnings(
      { channels: { [testCase.channel]: testCase.config } },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ prefix: actualPrefix, dmPolicy, effectiveAllowFrom }) => [
          `${testCase.id}|${actualPrefix}|${String(dmPolicy)}|${JSON.stringify(effectiveAllowFrom)}`,
        ],
      },
    );

    expect(warnings).toContain(
      `${testCase.id}|${prefix}|${testCase.expectedPolicy}|${JSON.stringify(testCase.expectedAllowFrom)}`,
    );
    if ("expectedWarningPath" in testCase && testCase.expectedWarningPath) {
      expect(
        warnings.some((warning) =>
          warning.startsWith(`- ${testCase.expectedWarningPath} is "allowlist"`),
        ),
      ).toBe(true);
    } else {
      expect(
        warnings.some(
          (warning) =>
            warning.startsWith("- channels.matrix.dm.policy is") ||
            warning.startsWith("- channels.matrix.accounts.work.dm.policy is") ||
            warning.startsWith("- channels.signal.dmPolicy is"),
        ),
      ).toBe(false);
    }
  });
});
