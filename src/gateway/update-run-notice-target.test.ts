import { expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionDeliveryRoute } from "../infra/session-delivery-queue.records.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  authorizeUpdateRunNoticeTarget,
  resolveUpdateRunNoticeTarget,
} from "./update-run-notice-target.js";

it("authorizes linked admins through Discord's direct-recipient grammar and current grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
      null,
      "default",
    );
    try {
      const cfg: OpenClawConfig = {
        gateway: {
          auth: { identityScopes: { "ada@example.test": ["operator.admin"] } },
          roles: {
            default: "member",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      const senderId = "123456789012345678";
      const profile = ensureProfileForEmail("ada@example.test");
      setUserProfileRole(profile.id, "admin");
      linkUserChannelIdentity(profile.id, { channelId: "discord", accountId: "team", senderId });
      const target = {
        kind: "route",
        route: {
          channel: "discord",
          accountId: "team",
          to: `user:${senderId}`,
          chatType: "direct",
        },
      } as const;
      const sessionKey = "agent:main:discord:direct:notice";
      const prepare = (route: SessionDeliveryRoute) =>
        resolveUpdateRunNoticeTarget({
          cfg,
          session: {
            cfg,
            agentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            store: {},
            canonicalKey: sessionKey,
            storeKeys: [sessionKey],
            legacyKey: undefined,
            entry: {
              sessionId: "notice-probe",
              updatedAt: 1,
              delivery: {
                kind: "external",
                route: {
                  channel: route.channel,
                  accountId: route.accountId,
                  target: { to: route.to, chatType: route.chatType },
                },
                context: route,
                origin: { provider: route.channel, chatType: route.chatType },
              },
            },
          },
        });
      for (const to of [`user:${senderId}`, `discord:user:${senderId}`, `<@${senderId}>`]) {
        const direct = { ...target, route: { ...target.route, to } };
        expect(await prepare(direct.route)).toMatchObject(direct);
      }
      for (const route of [
        { ...target.route, accountId: "another" },
        { ...target.route, to: `channel:${senderId}` },
        { ...target.route, chatType: "group" as const },
        { ...target.route, to: senderId, chatType: "channel" as const },
      ]) {
        expect((await prepare(route)).kind).toBe("none");
      }
      const admitted = await prepare(target.route);
      setUserProfileRole(profile.id, "member");
      expect(authorizeUpdateRunNoticeTarget(cfg, admitted).kind).toBe("none");
      expect((await prepare(target.route)).kind).toBe("none");
      setUserProfileRole(profile.id, "admin");
      expect(authorizeUpdateRunNoticeTarget(cfg, admitted).kind).toBe("none");
      expect(await prepare(target.route)).toMatchObject(target);
      cfg.gateway!.auth!.identityScopes = {};
      const restored = await prepare(target.route);
      expect(restored).toMatchObject(target);
      cfg.gateway!.roles!.definitions.admin!.scopes = ["operator.read"];
      expect(authorizeUpdateRunNoticeTarget(cfg, restored).kind).toBe("none");
    } finally {
      rollbackStagedPluginRegistry(previous);
    }
  });
});

it.each([
  {
    name: "retarget with a stored context thread",
    contextThread: "1234567890.123456",
    explicit: { to: "C0456DEF" },
    requestedThread: undefined,
    expectedTo: "C0456DEF",
    expectedReply: undefined,
  },
  {
    name: "retarget with only a routing-key thread",
    contextThread: undefined,
    explicit: { to: "C0456DEF" },
    requestedThread: undefined,
    expectedTo: "C0456DEF",
    expectedReply: undefined,
  },
  {
    name: "same normalized destination",
    contextThread: "1234567890.123456",
    explicit: { channel: " SLACK ", to: " C0123ABC ", accountId: " WORKSPACE-1 " },
    requestedThread: undefined,
    expectedTo: "C0123ABC",
    expectedReply: "1234567890.123456",
  },
  {
    name: "retarget with an explicit new thread",
    contextThread: "1234567890.123456",
    explicit: { to: "C0456DEF" },
    requestedThread: "2234567890.123456",
    expectedTo: "C0456DEF",
    expectedReply: "2234567890.123456",
  },
])(
  "keeps update notice threads bound to their destination in the resolver ($name)",
  async ({ contextThread, explicit, requestedThread, expectedTo, expectedReply }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
        pluginId: "slack",
        artifactBasename: "api.js",
      });
      const previous = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "slack", plugin: slackPlugin, source: "test" }]),
        null,
        "default",
      );
      try {
        const cfg: OpenClawConfig = {
          commands: { ownerAllowFrom: ["slack:C0123ABC", "slack:C0456DEF"] },
        };
        const sessionKey = "agent:main:slack:channel:c0123abc:thread:1234567890.123456";
        const context = {
          channel: "slack",
          accountId: "workspace-1",
          to: "C0123ABC",
          ...(contextThread ? { threadId: contextThread } : {}),
        };
        const params = {
          cfg,
          sessionKey,
          explicitDeliveryContext: explicit,
          threadId: requestedThread,
          session: {
            cfg,
            agentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            store: {},
            canonicalKey: sessionKey,
            storeKeys: [sessionKey],
            legacyKey: undefined,
            entry: {
              sessionId: "thread-retarget-probe",
              updatedAt: 1,
              delivery: {
                kind: "external" as const,
                route: {
                  channel: "slack",
                  accountId: "workspace-1",
                  target: { to: "C0123ABC", chatType: "channel" as const },
                  ...(contextThread ? { thread: { id: contextThread } } : {}),
                },
                context,
                origin: { provider: "slack", chatType: "channel" as const },
              },
            },
          },
        };
        const original = structuredClone(params);
        const target = await resolveUpdateRunNoticeTarget(params);
        expect(params).toEqual(original);
        expect(target.kind).toBe("route");
        expect(target.kind === "route" ? target.route : undefined).toEqual({
          channel: "slack",
          accountId: "workspace-1",
          to: expectedTo,
          chatType: "channel",
          threadId: undefined,
          replyToId: expectedReply,
        });
      } finally {
        rollbackStagedPluginRegistry(previous);
      }
    });
  },
);
