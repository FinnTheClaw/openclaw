// Msteams tests cover monitor handler.feedback authz plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { resolveMSTeamsRouteSessionKey } from "./monitor-handler/thread-session.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));
const channelInboundMockState = vi.hoisted(() => ({
  recordChannelFeedbackEvent: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  recordChannelFeedbackEvent: channelInboundMockState.recordChannelFeedbackEvent,
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? "/tmp",
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return createMSTeamsMessageHandlerDeps({
    cfg: params.cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      id: `invoke-${params.reaction}`,
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${params.senderId}-botframework`,
        aadObjectId: params.senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      value: {
        actionName: "feedback",
        actionValue: {
          reaction: params.reaction,
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  assertResult: () => Promise<void>;
}) {
  const deps = createDeps({ cfg: params.cfg });
  await runMSTeamsFeedbackInvokeHandler(createFeedbackInvokeContext(params.context), deps);
  await params.assertResult();
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
    channelInboundMockState.recordChannelFeedbackEvent.mockClear();
  });

  it.each([
    {
      name: "team positive",
      reaction: "like",
      teamId: "team-1",
      peerOverride: false,
      agentId: "team-agent",
      matchedBy: "binding.team",
    },
    {
      name: "team negative",
      reaction: "dislike",
      teamId: "team-1",
      peerOverride: false,
      agentId: "team-agent",
      matchedBy: "binding.team",
    },
    {
      name: "unbound team fallback",
      reaction: "dislike",
      teamId: "other-team",
      peerOverride: false,
      agentId: "fallback-agent",
      matchedBy: "binding.account",
    },
    {
      name: "peer binding precedence",
      reaction: "dislike",
      teamId: "team-1",
      peerOverride: true,
      agentId: "peer-agent",
      matchedBy: "binding.peer",
    },
  ] as const)(
    "feedback team route: $name",
    async ({ reaction, teamId, peerOverride, agentId, matchedBy }) => {
      const conversationId = "19:feedback@thread.tacv2";
      const threadId = "root-message-1";
      const cfg: OpenClawConfig = {
        agents: {
          entries: { "team-agent": {}, "fallback-agent": {}, "peer-agent": {} },
        },
        bindings: [
          ...(peerOverride
            ? [
                {
                  agentId: "peer-agent",
                  match: {
                    channel: "msteams",
                    peer: { kind: "channel" as const, id: conversationId },
                  },
                },
              ]
            : []),
          { agentId: "team-agent", match: { channel: "msteams", teamId: "team-1" } },
          { agentId: "fallback-agent", match: { channel: "msteams" } },
        ],
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
            feedbackReflection: true,
          },
        },
      };
      const configBytes = JSON.stringify(cfg);
      const deps = createDeps({ cfg });
      const core = createRuntimeStub(vi.fn(async () => []));
      core.channel.routing.resolveAgentRoute = resolveAgentRoute;
      setMSTeamsRuntime(core);
      const expectedRoute = resolveAgentRoute({
        cfg,
        channel: "msteams",
        teamId,
        peer: { kind: "channel", id: conversationId },
      });
      expect(expectedRoute).toMatchObject({ agentId, matchedBy });
      const expectedSessionKey = resolveMSTeamsRouteSessionKey({
        baseSessionKey: expectedRoute.sessionKey,
        isChannel: true,
        conversationMessageId: threadId,
      });
      expect(expectedSessionKey).toMatch(/:thread:root-message-1$/);
      const context = createFeedbackInvokeContext({
        reaction,
        conversationId: `${conversationId};messageid=${threadId}`,
        conversationType: "channel",
        senderId: "owner-aad",
        teamId,
        comment: "synthetic team feedback",
      });
      context.sendActivities = vi.fn(async () => []);

      expect(await runMSTeamsFeedbackInvokeHandler(context, deps)).toBe(true);

      expect(JSON.stringify(cfg)).toBe(configBytes);
      expect(context.sendActivity).not.toHaveBeenCalled();
      expect(context.sendActivities).not.toHaveBeenCalled();
      expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledExactlyOnceWith({
        cfg,
        agentId,
        sessionKey: expectedSessionKey,
        event: {
          type: "custom",
          event: "feedback",
          ts: expect.any(Number),
          messageId: "bot-msg-1",
          value: reaction === "like" ? "positive" : "negative",
          comment: "synthetic team feedback",
          sessionKey: expectedSessionKey,
          agentId,
          conversationId,
        },
      });
      if (reaction === "like") {
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      } else {
        expect(feedbackReflectionMockState.runFeedbackReflection).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            cfg,
            app: deps.app,
            agentId,
            sessionKey: expectedSessionKey,
            conversationId,
            conversationKind: "channel",
            userComment: "synthetic team feedback",
          }),
        );
      }
    },
  );

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith({
          cfg: expect.any(Object),
          agentId: "default",
          sessionKey: "msteams:direct:owner-aad",
          event: {
            type: "custom",
            event: "feedback",
            ts: expect.any(Number),
            messageId: "bot-msg-1",
            value: "positive",
            comment: "allowed feedback",
            sessionKey: "msteams:direct:owner-aad",
            agentId: "default",
            conversationId: "a:personal-chat",
          },
        });
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed dm feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "default",
            sessionKey: "msteams:direct:owner-aad",
            event: expect.objectContaining({ comment: "allowed dm feedback" }),
          }),
        );
      },
    });
  });

  it("does not record feedback when personal scope contradicts team metadata", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        teamId: "unexpected-team",
        comment: "must not cross scope",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "attacker-aad",
        senderName: "Attacker",
        comment: "blocked feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    const deps = createDeps({
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
            feedbackReflection: true,
          },
        },
      } as OpenClawConfig,
    });

    await runMSTeamsFeedbackInvokeHandler(
      createFeedbackInvokeContext({
        reaction: "dislike",
        conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
        conversationType: "groupChat",
        senderId: "attacker-aad",
        senderName: "Attacker",
        teamId: "team-1",
        channelName: "General",
        comment: "blocked reflection",
      }),
      deps,
    );

    expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
    expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
  });
});
