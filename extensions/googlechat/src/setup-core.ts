import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Googlechat plugin module implements setup core behavior.
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "googlechat" as const;

type GoogleChatSetupInput = ChannelSetupInput & {
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
};

export function clearDefaultGoogleChatCredentialOverrides(
  cfg: OpenClawConfig,
  accountId: string,
): OpenClawConfig {
  if (accountId !== "default") {
    return cfg;
  }
  const channelConfig = cfg.channels?.googlechat;
  const defaultAccount = channelConfig?.accounts?.default;
  if (!defaultAccount) {
    return cfg;
  }
  const { serviceAccount: _inline, serviceAccountFile: _file, ...shared } = defaultAccount;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      googlechat: {
        ...channelConfig,
        accounts: { ...channelConfig.accounts, default: shared },
      },
    },
  };
}

const baseGooglechatSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["token", "tokenFile"],
        message: "Google Chat requires --token (service account JSON) or --token-file.",
      },
    ],
  }),
  buildPatch: (input) => {
    const setupInput = input as GoogleChatSetupInput;
    const patch = setupInput.useEnv
      ? { serviceAccount: "", serviceAccountFile: "" }
      : setupInput.tokenFile
        ? { serviceAccount: "", serviceAccountFile: setupInput.tokenFile }
        : setupInput.token
          ? { serviceAccount: setupInput.token, serviceAccountFile: "" }
          : {};
    const audienceType = setupInput.audienceType?.trim();
    const audience = setupInput.audience?.trim();
    const webhookPath = setupInput.webhookPath?.trim();
    const webhookUrl = setupInput.webhookUrl?.trim();
    return {
      ...patch,
      ...(audienceType ? { audienceType } : {}),
      ...(audience ? { audience } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  },
});

export const googlechatSetupAdapter = {
  ...baseGooglechatSetupAdapter,
  applyAccountConfig: (
    params: Parameters<NonNullable<typeof baseGooglechatSetupAdapter.applyAccountConfig>>[0],
  ) => {
    const next = baseGooglechatSetupAdapter.applyAccountConfig!(params);
    const input = params.input as GoogleChatSetupInput;
    return input.useEnv || input.tokenFile || input.token
      ? clearDefaultGoogleChatCredentialOverrides(next, params.accountId)
      : next;
  },
};

export const googlechatSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <json>", description: "Google Chat service account JSON" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "Google Chat service account file" },
    },
    audienceType: {
      kind: "choice",
      choices: ["app-url", "project-number"],
      cli: { flags: "--audience-type <type>", description: "Google Chat audience type" },
    },
    audience: {
      kind: "string",
      cli: { flags: "--audience <value>", description: "Google Chat audience value" },
    },
    webhookPath: {
      kind: "string",
      cli: { flags: "--webhook-path <path>", description: "Google Chat webhook path" },
    },
    webhookUrl: {
      kind: "string",
      cli: { flags: "--webhook-url <url>", description: "Google Chat webhook URL" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Google Chat environment credentials" },
      envVars: ["GOOGLE_CHAT_SERVICE_ACCOUNT", "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE"],
      envVarMode: "any",
    },
  },
  legacyAdapter: googlechatSetupAdapter,
});
