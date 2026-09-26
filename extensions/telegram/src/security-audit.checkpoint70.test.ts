// Exactly ten collector-level cases for R70-03-F01. Intended source path:
// extensions/telegram/src/security-audit.checkpoint70.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

const INVALID = "channels.telegram.allowFrom.invalid_entries";
const MISSING = "channels.telegram.groups.allowFrom.missing";
const GROUP_ID = "-100123";

type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;

function makeConfig(telegram: TelegramConfig, text: boolean): OpenClawConfig {
  return { commands: { text }, channels: { telegram } };
}

function makeAccount(telegram: TelegramConfig): ResolvedTelegramAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    tokenSource: "config",
    tokenStatus: "available",
    config: telegram,
  };
}

async function audit(telegram: TelegramConfig, text: boolean) {
  const cfg = makeConfig(telegram, text);
  return await collectTelegramSecurityAuditFindings({
    cfg,
    account: makeAccount(telegram),
    accountId: "default",
  });
}

function idsAndSeverity(findings: Awaited<ReturnType<typeof audit>>) {
  return findings.map(({ checkId, severity }) => ({ checkId, severity }));
}

function configuredGroup(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    enabled: true,
    botToken: "t",
    groupPolicy: "allowlist",
    groups: { [GROUP_ID]: {} },
    ...overrides,
  };
}

describe("Telegram security audit checkpoint 70 invalid allowlist diagnostics", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
    readChannelAllowFromStoreMock.mockResolvedValue([]);
  });

  it("CP70-TG01 reports invalid groupAllowFrom with text commands disabled", async () => {
    const findings = await audit(configuredGroup({ groupAllowFrom: ["@bad-global"] }), false);
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
  });

  it("CP70-TG02 reports invalid per-group allowFrom with text commands disabled", async () => {
    const findings = await audit(
      configuredGroup({ groups: { [GROUP_ID]: { allowFrom: ["@bad-group"] } } }),
      false,
    );
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
  });

  it("CP70-TG03 reports invalid topic allowFrom with text commands disabled", async () => {
    const findings = await audit(
      configuredGroup({
        groups: { [GROUP_ID]: { topics: { "42": { allowFrom: ["@bad-topic"] } } } },
      }),
      false,
    );
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
  });

  it("CP70-TG04 reports invalid pairing-store entry with text commands disabled", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["@bad-store"]);
    const findings = await audit(configuredGroup(), false);
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledOnce();
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledWith("telegram", process.env, "default");
  });

  it("CP70-TG05 does not flag a numeric group allowlist", async () => {
    const findings = await audit(configuredGroup({ groupAllowFrom: ["123456"] }), false);
    expect(idsAndSeverity(findings)).toEqual([]);
  });

  it("CP70-TG06 retains DM-only invalid-entry warning without store read", async () => {
    const findings = await audit(
      {
        enabled: true,
        botToken: "t",
        dmPolicy: "allowlist",
        allowFrom: ["@bad-dm"],
        groupPolicy: "allowlist",
      },
      false,
    );
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("CP70-TG07 retains no-group quiet path without store read", async () => {
    const findings = await audit({ enabled: true, botToken: "t", groupPolicy: "allowlist" }, false);
    expect(idsAndSeverity(findings)).toEqual([]);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("CP70-TG08 retains text-disabled wildcard command-warning suppression", async () => {
    const findings = await audit(configuredGroup({ groupAllowFrom: ["*"] }), false);
    expect(idsAndSeverity(findings)).toEqual([]);
  });

  it("CP70-TG09 retains text-enabled invalid-entry warning", async () => {
    const findings = await audit(configuredGroup({ groupAllowFrom: ["@bad-global"] }), true);
    expect(idsAndSeverity(findings)).toEqual([{ checkId: INVALID, severity: "warn" }]);
  });

  it("CP70-TG10 retains text-enabled missing-allowlist warning", async () => {
    const findings = await audit(configuredGroup(), true);
    expect(idsAndSeverity(findings)).toEqual([{ checkId: MISSING, severity: "critical" }]);
  });
});
