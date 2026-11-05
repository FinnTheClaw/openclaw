// Zalo tests cover setup surface plugin behavior.
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import { listZaloAccountIds, resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { zaloDmPolicy } from "./setup-core.js";
import { zaloSetupAdapter, zaloSetupWizard } from "./setup-surface.js";

const zaloSetupPlugin = {
  id: "zalo",
  meta: {
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
    docsPath: "/channels/zalo",
    blurb: "Vietnam-focused messaging platform with Bot API.",
  },
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
  },
  config: {
    listAccountIds: (cfg: unknown) => listZaloAccountIds(cfg as never),
    defaultAccountId: (cfg: unknown) => resolveDefaultZaloAccountId(cfg as never),
    resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  },
  setup: zaloSetupAdapter,
  setupWizard: zaloSetupWizard,
} as const;

const zaloConfigure = createPluginSetupWizardConfigure(zaloSetupPlugin);

describe("zalo setup wizard", () => {
  it.each([
    {
      name: "named account inherits root webhook",
      expectedInitialWebhook: false,
      accountId: "work",
      nested: true,
      rootWebhook: true,
      accountWebhook: false,
      preserveRoot: true,
    },
    {
      name: "literal default has nested webhook override",
      expectedInitialWebhook: true,
      accountId: "default",
      nested: true,
      rootWebhook: true,
      accountWebhook: true,
      preserveRoot: true,
    },
    {
      name: "named local webhook without root defaults",
      expectedInitialWebhook: true,
      accountId: "work",
      nested: true,
      rootWebhook: false,
      accountWebhook: true,
      preserveRoot: true,
    },
    {
      name: "legacy default root webhook without accounts",
      expectedInitialWebhook: true,
      accountId: "default",
      nested: false,
      rootWebhook: true,
      accountWebhook: false,
      preserveRoot: false,
    },
  ])("effective polling mode: $name", async (row) => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "123:fixture-root",
          dmPolicy: "allowlist",
          allowFrom: ["111"],
          groupPolicy: "allowlist",
          ...(row.rootWebhook
            ? {
                webhookUrl: "https://root.example.test/zalo",
                webhookSecret: "fixture-root-secret",
                webhookPath: "/root-zalo",
              }
            : {}),
          ...(row.nested
            ? {
                accounts: {
                  [row.accountId]: {
                    enabled: true,
                    botToken: "234:fixture-selected",
                    dmPolicy: "pairing" as const,
                    ...(row.accountWebhook
                      ? {
                          webhookUrl: "https://selected.example.test/zalo",
                          webhookSecret: "fixture-selected-secret",
                          webhookPath: "/selected-zalo",
                        }
                      : {}),
                  },
                  sibling: {
                    enabled: false,
                    botToken: "345:fixture-sibling",
                    webhookUrl: "https://sibling.example.test/zalo",
                    webhookSecret: "fixture-sibling-secret",
                    webhookPath: "/sibling-zalo",
                    dmPolicy: "allowlist" as const,
                    allowFrom: ["999"],
                  },
                },
              }
            : {}),
        },
      },
    };
    const before = structuredClone(cfg);
    const normalizedBefore = row.nested
      ? moveSingleAccountChannelSectionToDefaultAccount({
          cfg: before,
          channelKey: "zalo",
          setupSurface: zaloSetupAdapter,
        })
      : before;
    const confirm = vi.fn(async ({ message }: { message: string }) =>
      message === "Use webhook mode for Zalo?" ? false : true,
    );
    const text = vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`Unexpected prompt: ${message}`);
    }) as WizardPrompter["text"];
    const result = await runSetupWizardConfigure({
      configure: zaloConfigure,
      cfg,
      prompter: createTestWizardPrompter({ confirm, text }),
      accountOverrides: { zalo: row.accountId },
      options: { secretInputMode: "plaintext" as const },
    });
    const account = resolveZaloAccount({ cfg: result.cfg, accountId: row.accountId });
    const { accounts: actualAccounts, ...actualRoot } = result.cfg.channels!.zalo!;
    const { accounts: originalAccounts, ...expectedRoot } = normalizedBefore.channels!.zalo!;
    if (!row.preserveRoot) {
      delete expectedRoot.webhookUrl;
      delete expectedRoot.webhookSecret;
      delete expectedRoot.webhookPath;
    }
    expect(cfg).toEqual(before);
    expect({
      accountId: result.accountId,
      effectiveWebhook: Boolean(account.config.webhookUrl),
      token: account.token,
      dmPolicy: account.config.dmPolicy,
      root: actualRoot,
      sibling: actualAccounts?.sibling,
      siblingResolved: row.nested
        ? resolveZaloAccount({ cfg: result.cfg, accountId: "sibling" }).config
        : undefined,
      unselectedDefault:
        row.nested && row.accountId !== "default"
          ? resolveZaloAccount({ cfg: result.cfg, accountId: "default" }).config
          : undefined,
    }).toEqual({
      accountId: row.accountId,
      effectiveWebhook: false,
      token: row.nested ? "234:fixture-selected" : "123:fixture-root",
      dmPolicy: row.nested ? "pairing" : "allowlist",
      root: expectedRoot,
      sibling: originalAccounts?.sibling,
      siblingResolved: row.nested
        ? resolveZaloAccount({ cfg: normalizedBefore, accountId: "sibling" }).config
        : undefined,
      unselectedDefault:
        row.nested && row.accountId !== "default"
          ? resolveZaloAccount({ cfg: normalizedBefore, accountId: "default" }).config
          : undefined,
    });
    expect(confirm).toHaveBeenCalledWith({
      message: "Use webhook mode for Zalo?",
      initialValue: row.expectedInitialWebhook,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("configures a polling token flow", async () => {
    const prompter = createTestWizardPrompter({
      select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Zalo bot token") {
          return "12345689:abc-xyz";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use webhook mode for Zalo?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetupWizardConfigure({
      configure: zaloConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.accountId).toBe("default");
    const zaloConfig = result.cfg.channels?.zalo;
    if (!zaloConfig) {
      throw new Error("expected Zalo config");
    }
    expect(zaloConfig.enabled).toBe(true);
    expect(zaloConfig.botToken).toBe("12345689:abc-xyz");
    expect(zaloConfig.webhookUrl).toBeUndefined();
  });

  installChannelDmPolicyContractSuite({
    dmPolicy: zaloDmPolicy,
    cases: [
      {
        name: "Zalo named accounts",
        channel: "zalo",
        accountId: "work",
        accountConfig: { botToken: "12345689:abc-xyz" },
        inheritedAllowFrom: ["123456789"],
        defaultAccount: { rootAllowFrom: ["123456789"] },
      },
    ],
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await zaloSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            botToken: "root-token",
            accounts: {
              alerts: {
                botToken: "alerts-token",
              },
              work: {
                botToken: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});
