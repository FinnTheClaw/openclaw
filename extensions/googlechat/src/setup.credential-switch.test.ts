import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveGoogleChatAccount } from "./accounts.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const inline = { client_email: "new@example.com" };
const priorInline = { client_email: "old@example.com" };

function applyCli(
  cfg: OpenClawConfig,
  accountId: string,
  input: Record<string, unknown>,
): OpenClawConfig {
  const apply = googlechatSetupAdapter.applyAccountConfig;
  if (!apply) {
    throw new Error("Google Chat setup adapter is missing applyAccountConfig");
  }
  return apply({ cfg, accountId, input } as never);
}

async function applyWizardInput(
  cfg: OpenClawConfig,
  accountId: string,
  inputKey: "token" | "tokenFile",
  value: string,
): Promise<OpenClawConfig> {
  const input = googlechatSetupWizard.textInputs?.find((entry) => entry.inputKey === inputKey);
  if (!input?.applySet) {
    throw new Error(`Google Chat wizard is missing ${inputKey} input`);
  }
  return await input.applySet({ cfg, accountId, value } as never);
}

describe("Google Chat credential switch regression pack", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("G01 default inline to file selects the file", () => {
    const cfg = { channels: { googlechat: { serviceAccount: priorInline } } } as OpenClawConfig;
    const next = applyCli(cfg, "default", { tokenFile: "/tmp/new-sa.json" });
    expect(next.channels?.googlechat?.serviceAccount).toBe("");
    expect(next.channels?.googlechat?.serviceAccountFile).toBe("/tmp/new-sa.json");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "file",
    );
  });

  it("G02 default file to inline selects the inline account", () => {
    const cfg = {
      channels: { googlechat: { serviceAccountFile: "/tmp/old-sa.json" } },
    } as OpenClawConfig;
    const next = applyCli(cfg, "default", { token: inline });
    expect(next.channels?.googlechat?.serviceAccountFile).toBe("");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "inline",
    );
  });

  it("G03 default inline to environment stops using configured inline auth", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", JSON.stringify(inline));
    const cfg = { channels: { googlechat: { serviceAccount: priorInline } } } as OpenClawConfig;
    const next = applyCli(cfg, "default", { useEnv: true });
    expect(next.channels?.googlechat?.serviceAccount).toBe("");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "env",
    );
  });

  it("G04 default file to environment stops using configured file auth", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", JSON.stringify(inline));
    const cfg = {
      channels: { googlechat: { serviceAccountFile: "/tmp/old-sa.json" } },
    } as OpenClawConfig;
    const next = applyCli(cfg, "default", { useEnv: true });
    expect(next.channels?.googlechat?.serviceAccountFile).toBe("");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "env",
    );
  });

  it("G05 named file selection masks inherited root inline auth", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: priorInline,
          accounts: { alerts: { serviceAccount: priorInline } },
        },
      },
    } as OpenClawConfig;
    const next = applyCli(cfg, "alerts", { tokenFile: "/tmp/alerts-new.json" });
    expect(next.channels?.googlechat?.serviceAccount).toEqual(priorInline);
    expect(next.channels?.googlechat?.accounts?.alerts?.serviceAccount).toBe("");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "alerts" }).credentialSource).toBe(
      "file",
    );
  });

  it("G06 named inline selection masks inherited root file auth", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccountFile: "/tmp/root.json",
          accounts: { alerts: { serviceAccountFile: "/tmp/old-alerts.json" } },
        },
      },
    } as OpenClawConfig;
    const next = applyCli(cfg, "alerts", { token: inline });
    expect(next.channels?.googlechat?.serviceAccountFile).toBe("/tmp/root.json");
    expect(next.channels?.googlechat?.accounts?.alerts?.serviceAccountFile).toBe("");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "alerts" }).credentialSource).toBe(
      "inline",
    );
  });

  it("G07 wizard file selection replaces old inline and keeps webhook settings", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: priorInline,
          webhookPath: "/googlechat",
        },
      },
    } as OpenClawConfig;
    const next = await applyWizardInput(cfg, "default", "tokenFile", "/tmp/wizard.json");
    expect(next.channels?.googlechat?.webhookPath).toBe("/googlechat");
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "file",
    );
  });

  it("G08 wizard inline selection replaces a named file and leaves a sibling unchanged", async () => {
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            alerts: { serviceAccountFile: "/tmp/alerts-old.json" },
            sibling: { serviceAccountFile: "/tmp/sibling.json" },
          },
        },
      },
    } as OpenClawConfig;
    const next = await applyWizardInput(cfg, "alerts", "token", JSON.stringify(inline));
    expect(next.channels?.googlechat?.accounts?.alerts?.serviceAccountFile).toBe("");
    expect(next.channels?.googlechat?.accounts?.sibling?.serviceAccountFile).toBe(
      "/tmp/sibling.json",
    );
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "alerts" }).credentialSource).toBe(
      "inline",
    );
  });

  it("G09 wizard environment selection clears stale accounts.default override", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", JSON.stringify(inline));
    const cfg = {
      channels: {
        googlechat: {
          serviceAccountFile: "/tmp/root-old.json",
          accounts: { default: { serviceAccount: priorInline, webhookPath: "/old-webhook" } },
        },
      },
    } as OpenClawConfig;
    const result = await googlechatSetupWizard.prepare?.({
      cfg,
      accountId: "default",
      credentialValues: {},
      prompter: { confirm: async () => true } as never,
    } as never);
    const next = result?.cfg;
    if (!next) {
      throw new Error("Expected environment setup result");
    }
    expect(next.channels?.googlechat?.accounts?.default?.webhookPath).toBe("/old-webhook");
    expect(next.channels?.googlechat?.accounts?.default?.serviceAccount).toBeUndefined();
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "env",
    );
  });

  it("G10 default CLI switch clears accounts.default credentials but preserves named credentials", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: priorInline,
          accounts: {
            default: { serviceAccount: priorInline, audience: "old-audience" },
            alerts: { serviceAccount: priorInline, enabled: false },
          },
        },
      },
    } as OpenClawConfig;
    const next = applyCli(cfg, "default", { tokenFile: "/tmp/new-default.json" });
    expect(next.channels?.googlechat?.accounts?.default?.audience).toBe("old-audience");
    expect(next.channels?.googlechat?.accounts?.default?.serviceAccount).toBeUndefined();
    expect(next.channels?.googlechat?.accounts?.alerts).toEqual(
      cfg.channels?.googlechat?.accounts?.alerts,
    );
    expect(resolveGoogleChatAccount({ cfg: next, accountId: "default" }).credentialSource).toBe(
      "file",
    );
  });
});
