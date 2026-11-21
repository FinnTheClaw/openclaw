import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

const user = { postAs: "user", userToken: "test-user-token" };
const relay = {
  url: "test-relay-url",
  authToken: "test-relay-auth-token",
  gatewayId: "test-gateway-id",
};

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    expect(SlackConfigSchema.parse({}).groupPolicy).toBe("allowlist");
  });

  it.each([
    ["inherited user transport", { ...user, appToken: "test-app-token", accounts: { work: {} } }],
    ["relay user transport", { ...user, mode: "relay", relay }],
    ["disabled relay", { enabled: false, mode: "relay" }],
    [
      "disabled inherited relay",
      { enabled: false, mode: "relay", accounts: { ops: { mode: "relay" } } },
    ],
    [
      "disabled inherited HTTP account",
      {
        mode: "http",
        accounts: {
          disabled: { enabled: false },
          ops: { botToken: "test-bot-token", signingSecret: "test-ops-signing-secret" },
        },
      },
    ],
    ["only disabled HTTP account", { mode: "http", accounts: { ops: { enabled: false } } }],
  ])("accepts %s", (_name, config) => {
    expect(SlackConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each([
    ["allowFrom", { dmPolicy: "open", allowFrom: ["U123"] }, false],
    ["relay.url", { mode: "relay" }, false],
    ["relay.authToken", { mode: "relay", relay: { url: relay.url } }, false],
    [
      "relay.gatewayId",
      { mode: "relay", relay: { url: relay.url, authToken: relay.authToken } },
      false,
    ],
    ["signingSecret", { mode: "http" }, false],
    [
      "accounts.ops.signingSecret",
      { mode: "http", accounts: { ops: { botToken: "test-bot-token" } } },
      true,
    ],
  ] as const)("reports missing or invalid %s", (path, config, exact) => {
    const result = SlackConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(exact ? [path] : expect.arrayContaining([path]));
    }
  });
  it.each([
    {
      name: "R13 relay validation: rejects missing relay fields when accounts are omitted",
      config: { mode: "relay" },
      issue: "relay.url",
    },
    {
      name: "R13 relay validation: rejects missing relay fields when accounts are empty",
      config: { mode: "relay", accounts: {} },
      issue: "relay.url",
    },
    {
      name: "R13 relay validation: rejects missing auth token with empty accounts",
      config: { mode: "relay", accounts: {}, relay: { url: "wss://router.example/ws" } },
      issue: "relay.authToken",
    },
    {
      name: "R13 relay validation: rejects missing gateway ID with empty accounts",
      config: {
        mode: "relay",
        accounts: {},
        relay: { url: "wss://router.example/ws", authToken: "test-token" },
      },
      issue: "relay.gatewayId",
    },
    {
      name: "R13 relay validation: accepts complete string relay credentials with empty accounts",
      config: {
        mode: "relay",
        accounts: {},
        relay: { url: "wss://router.example/ws", authToken: "test-token", gatewayId: "gateway" },
      },
    },
    {
      name: "R13 relay validation: accepts complete SecretInput relay credentials with empty accounts",
      config: {
        mode: "relay",
        accounts: {},
        relay: {
          url: "wss://router.example/ws",
          authToken: { source: "env", provider: "default", id: "SLACK_RELAY_AUTH_TOKEN" },
          gatewayId: "gateway",
        },
      },
    },
    {
      name: "R13 relay validation: does not require relay fields for disabled Slack with empty accounts",
      config: { enabled: false, mode: "relay", accounts: {} },
    },
    {
      name: "R13 relay validation: accepts complete relay credentials on a named account without root relay",
      config: {
        mode: "relay",
        accounts: {
          ops: {
            relay: {
              url: "wss://router.example/ws",
              authToken: "test-token",
              gatewayId: "gateway",
            },
          },
        },
      },
    },
    {
      name: "R13 relay validation: inherits complementary root relay fields for a named account",
      config: {
        mode: "relay",
        relay: { url: "wss://router.example/ws", authToken: "test-token" },
        accounts: { ops: { relay: { gatewayId: "gateway" } } },
      },
    },
    {
      name: "R13 relay validation: honors a named account socket override without root relay fields",
      config: { mode: "relay", accounts: { ops: { mode: "socket" } } },
    },
  ])("$name", ({ config, issue }) => {
    if (issue) {
      const result = SlackConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((item) => item.path.join("."))).toContain(issue);
      }
    } else {
      expect(SlackConfigSchema.safeParse(config).success).toBe(true);
    }
  });
});
