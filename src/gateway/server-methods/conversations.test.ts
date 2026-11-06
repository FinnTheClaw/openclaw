import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getConversationDeliveryOperation } from "../../config/sessions/conversation-delivery-store.js";
import * as conversationRegistry from "../../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import {
  conversation,
  createConversationDeliveryTestStore,
  holdConversationWriterForTest,
  queueConversationDeliveryForTest,
} from "../conversation-delivery.test-support.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import { runGatewayConversationList } from "../conversation-list.js";
import { runGatewayConversationSend } from "../conversation-send.js";
import { runGatewayConversationTurn } from "../conversation-turn.js";
import { createOperatorClient } from "../node-invoke-plugin-policy.test-helpers.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { conversationHandlers } from "./conversations.js";
import { captureGatewayRequestOperatorGuard } from "./session-mutation-guards.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

vi.mock("../../sessions/conversation-turns.js", () => ({ cancelPendingConversationTurn: vi.fn() }));
vi.mock("../conversation-list.js", () => ({ runGatewayConversationList: vi.fn() }));
vi.mock("../conversation-send.js", () => ({ runGatewayConversationSend: vi.fn() }));
vi.mock("../conversation-turn.js", () => ({ runGatewayConversationTurn: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

const request = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  turnId: "conversation-turn-1",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "hello molty",
  timeoutMs: 30_000,
};

const result = {
  status: "replied" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  correlationPersisted: true,
  reply: {
    conversationRef: request.conversationRef,
    messageId: "reef-inbound-1",
    replyToId: "reef-outbound-1",
    text: "hello clawd",
    timestamp: 300,
  },
};

const sendRequest = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  operationId: "conversation-send-1",
  conversationRef: request.conversationRef,
  message: "hello molty",
};

const sendResult = {
  status: "sent" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  queueId: "conversation-send-1",
};

const adminClient = {
  connect: { scopes: ["operator.admin"] },
} as never;

function context(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

function invoke(params: {
  handler: NonNullable<(typeof conversationHandlers)["conversations.turn"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? request,
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "1", method: "conversations.turn" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

function invokeSend(params: {
  handler: NonNullable<(typeof conversationHandlers)["conversations.send"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? sendRequest,
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "send-1", method: "conversations.send" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

function invokeList(params: {
  handler: NonNullable<(typeof conversationHandlers)["conversations.list"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? { agentId: "main", channel: "reef", query: "@molty", limit: 50 },
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "list-1", method: "conversations.list" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

describe("conversations.list Gateway handler", () => {
  it("runs discovery and listing inside the Gateway runtime", async () => {
    const listed = {
      conversations: [
        {
          conversationRef: request.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct" as const,
          target: "reef:molty",
          firstSeenAt: 100,
          lastSeenAt: 100,
        },
      ],
    };
    const runConversationList = vi
      .mocked(runGatewayConversationList)
      .mockImplementation(
        async (_params: Parameters<typeof runGatewayConversationList>[0]) => listed,
      );
    const handler = conversationHandlers["conversations.list"]!;
    const respond = vi.fn<RespondFn>();

    await invokeList({ handler, context: context(), respond });

    expect(runConversationList).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.any(Object),
        agentId: "main",
        channel: "reef",
        query: "@molty",
        limit: 50,
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, listed, undefined);
  });

  it("rejects invalid limits before directory discovery", async () => {
    const runConversationList = vi.mocked(runGatewayConversationList);
    const handler = conversationHandlers["conversations.list"]!;
    const respond = vi.fn<RespondFn>();

    await invokeList({
      handler,
      context: context(),
      respond,
      request: { agentId: "main", channel: "reef", limit: 101 },
    });

    expect(runConversationList).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("conversations.send Gateway handler", () => {
  it.each([
    { boundary: "initial lookup", revoke: true },
    { boundary: "first create", revoke: true },
    { boundary: "first create", revoke: false },
    { boundary: "already created", revoke: true },
  ] as const)(
    "L01-F12 retains requester currentness until first conversation admission: $boundary revoked=$revoke",
    async ({ boundary, revoke }) => {
      const actualSend =
        await vi.importActual<typeof import("../conversation-send.js")>("../conversation-send.js");
      vi.mocked(runGatewayConversationSend).mockImplementation(
        actualSend.runGatewayConversationSend,
      );
      const store = createConversationDeliveryTestStore();
      const cfg: OpenClawConfig = {
        ...store.config,
        gateway: {
          roles: {
            definitions: {
              sender: { scopes: ["operator.admin"], sessions: { others: "all" }, agents: ["*"] },
              viewer: { scopes: [], sessions: { others: "none" }, agents: [] },
            },
          },
        },
      };
      const cfgBefore = structuredClone(cfg);
      const scope = conversationRegistry.resolveConversationRegistryScope({
        agentId: "main",
        config: cfg,
      });
      expect(
        conversationRegistry.resolveConversation(scope, conversation.conversationRef),
      ).toMatchObject({
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });
      const params = {
        ...sendRequest,
        operationId: `authority-${boundary.replaceAll(" ", "-")}-${revoke}`,
        conversationRef: conversation.conversationRef,
      };
      const paramsBefore = structuredClone(params);
      expect(getConversationDeliveryOperation(scope, params.operationId)).toBeUndefined();
      const entered = createDeferred();
      const releaseAction = createDeferred();
      let writer: ReturnType<typeof holdConversationWriterForTest> | undefined;
      const actualWrite = conversationRegistry.runConversationDatabaseWrite;
      let writeCalls = 0;
      const gateReceipts: Array<{ agentId: string; storePath: string | undefined }> = [];
      const gatedWrite = boundary === "initial lookup" ? 1 : boundary === "first create" ? 2 : 0;
      const writeSpy = vi
        .spyOn(conversationRegistry, "runConversationDatabaseWrite")
        .mockImplementation(async (input, write) => {
          writeCalls += 1;
          if (writeCalls === gatedWrite) {
            writer = holdConversationWriterForTest(scope);
            await writer.entered;
            const queued = actualWrite(input, write);
            gateReceipts.push({ agentId: input.agentId, storePath: input.storePath });
            entered.resolve();
            return await queued;
          }
          return await actualWrite(input, write);
        });
      const actionReceipts: Array<{
        operationId: string | undefined;
        status: string | undefined;
        queueId: string | undefined;
      }> = [];
      let attempts = 0;
      const actionSpy = vi
        .spyOn(messageActionRunner, "runMessageAction")
        .mockImplementation(async (input) => {
          const created = getConversationDeliveryOperation(scope, params.operationId);
          actionReceipts.push({
            operationId: created?.operationId,
            status: created?.status,
            queueId: created?.queueId,
          });
          if (boundary === "already created") {
            entered.resolve();
            await releaseAction.promise;
          }
          await input.onDeliveryAttempt?.();
          attempts += 1;
          await queueConversationDeliveryForTest(input);
          return {
            kind: "send",
            channel: "reef",
            action: "send",
            to: conversation.target,
            handledBy: "core",
            payload: {},
            dryRun: false,
            sendResult: {
              channel: "reef",
              to: conversation.target,
              via: "direct",
              mediaUrl: null,
              result: { messageId: "fixture-outbound" },
              deliveryStatus: "sent",
            },
          };
        });
      let current = true;
      const profile = {
        profileId: "fixture-conversation-sender",
        aliases: new Set(["fixture-conversation-sender"]),
        role: "sender",
      };
      const client = createOperatorClient("fixture-conversation-connection");
      client.connect.role = "operator";
      client.connect.scopes = ["operator.admin"];
      client.preparedSessionProfile = profile;
      client.authenticatedUserProfile = {
        profileId: profile.profileId,
        displayName: "Fixture sender",
        avatarRevision: "fixture",
        hasAvatar: false,
        updatedAt: 1,
      };
      const gatewayContext = {
        ...context(),
        getRuntimeConfig: () => cfg,
        getCommittedRuntimeConfig: () => cfg,
      };
      const respond = vi.fn<RespondFn>();
      const handler = conversationHandlers["conversations.send"]!;
      const options = {
        params,
        respond,
        context: gatewayContext,
        req: { type: "req", id: params.operationId, method: "conversations.send" },
        client,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      } as Parameters<typeof handler>[0];
      expect(authorizeCurrentOperatorRoleScopes(client, cfg)).toBeUndefined();
      const capturedGuard = captureGatewayRequestOperatorGuard(options);
      expect(capturedGuard).not.toThrow();
      let pending: Promise<unknown> | undefined;
      try {
        pending = Promise.resolve(handler(options));
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("conversation handler settled before its owned admission gate");
          }),
        ]);
        await setImmediate();
        const held = {
          responses: respond.mock.calls.length,
          actions: actionSpy.mock.calls.length,
          operation: getConversationDeliveryOperation(scope, params.operationId),
          gateReceipts: [...gateReceipts],
        };
        if (revoke) {
          current = false;
          profile.role = "viewer";
        }
        const roleDenied = authorizeCurrentOperatorRoleScopes(client, cfg)?.code === "FORBIDDEN";
        let guardDenied = false;
        try {
          capturedGuard();
        } catch {
          guardDenied = true;
        }
        releaseAction.resolve();
        await writer?.release();
        await pending;
        const persisted = getConversationDeliveryOperation(scope, params.operationId);
        const denied = revoke && boundary !== "already created";
        const facts = {
          held: {
            responses: held.responses,
            actions: held.actions,
            status: held.operation?.status,
            queueId: held.operation?.queueId,
            gateReceipts: held.gateReceipts,
          },
          roleDenied,
          guardDenied,
          actionReceipts,
          attempts,
          persisted: persisted && {
            operationId: persisted.operationId,
            status: persisted.status,
            conversationRef: persisted.conversationRef,
            sourceSessionKey: persisted.sourceSessionKey,
            queueId: persisted.queueId,
            platformMessageId: persisted.platformMessageId,
          },
          responses: respond.mock.calls.map(([ok, value, error]) => ({
            ok,
            value,
            errorPresent: error !== undefined,
          })),
          paramsUnchanged: params,
          cfgUnchanged: cfg,
        };
        expect(facts).toEqual({
          held: {
            responses: 0,
            actions: boundary === "already created" ? 1 : 0,
            status: boundary === "already created" ? "created" : undefined,
            queueId: undefined,
            gateReceipts:
              boundary === "already created"
                ? []
                : [{ agentId: "main", storePath: scope.storePath }],
          },
          roleDenied: revoke,
          guardDenied: revoke,
          actionReceipts: denied
            ? []
            : [{ operationId: params.operationId, status: "created", queueId: undefined }],
          attempts: denied ? 0 : 1,
          persisted: denied
            ? undefined
            : {
                operationId: params.operationId,
                status: "sent",
                conversationRef: params.conversationRef,
                sourceSessionKey: params.sourceSessionKey,
                queueId: "queue-1",
                platformMessageId: "fixture-outbound",
              },
          responses: denied
            ? [{ ok: false, value: undefined, errorPresent: true }]
            : [
                {
                  ok: true,
                  value: {
                    status: "sent",
                    conversationRef: params.conversationRef,
                    channel: "reef",
                    messageId: "fixture-outbound",
                    queueId: "queue-1",
                  },
                  errorPresent: false,
                },
              ],
          paramsUnchanged: paramsBefore,
          cfgUnchanged: cfgBefore,
        });
      } finally {
        releaseAction.resolve();
        await writer?.release();
        await pending?.catch(() => undefined);
        actionSpy.mockRestore();
        writeSpy.mockRestore();
      }
    },
  );

  it("rejects a source session owned by another agent", async () => {
    const runConversationSend = vi.mocked(runGatewayConversationSend);
    const handler = conversationHandlers["conversations.send"]!;
    const respond = vi.fn<RespondFn>();

    await invokeSend({
      handler,
      context: context(),
      respond,
      request: { ...sendRequest, sourceSessionKey: "agent:ops:main" },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining("ops") }),
    );
    expect(runConversationSend).not.toHaveBeenCalled();
  });

  it("owns the send and rejects operation-id reuse with different source input", async () => {
    const runConversationSend = vi
      .mocked(runGatewayConversationSend)
      .mockImplementation(async () => sendResult);
    const handler = conversationHandlers["conversations.send"]!;
    const gatewayContext = context();
    const respond = vi.fn<RespondFn>();

    await invokeSend({ handler, context: gatewayContext, respond });
    expect(runConversationSend).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "conversation-send-1",
        conversationRef: request.conversationRef,
        message: "hello molty",
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });

    const mismatchRespond = vi.fn<RespondFn>();
    await invokeSend({
      handler,
      context: gatewayContext,
      respond: mismatchRespond,
      request: { ...sendRequest, sourceSessionKey: "agent:main:discord:channel:other" },
    });
    expect(runConversationSend).toHaveBeenCalledOnce();
    expect(mismatchRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps concurrent operation IDs isolated between agents", async () => {
    let finishMain: ((value: typeof sendResult) => void) | undefined;
    const otherResult = { ...sendResult, messageId: "reef-outbound-other" };
    const runConversationSend = vi
      .mocked(runGatewayConversationSend)
      .mockImplementation(async ({ agentId }: Parameters<typeof runGatewayConversationSend>[0]) =>
        agentId === "main"
          ? await new Promise<typeof sendResult>((resolve) => {
              finishMain = resolve;
            })
          : otherResult,
      );
    const handler = conversationHandlers["conversations.send"]!;
    const gatewayContext = context();
    const mainRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();

    const main = invokeSend({ handler, context: gatewayContext, respond: mainRespond });
    await vi.waitFor(() => expect(runConversationSend).toHaveBeenCalledOnce());
    const other = invokeSend({
      handler,
      context: gatewayContext,
      respond: otherRespond,
      request: {
        ...sendRequest,
        agentId: "other-agent",
        sourceSessionKey: "agent:other-agent:telegram:direct:operator",
      },
    });
    await vi.waitFor(() => expect(runConversationSend).toHaveBeenCalledTimes(2));
    finishMain?.(sendResult);
    await Promise.all([main, other]);

    expect(mainRespond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });
    expect(otherRespond).toHaveBeenCalledWith(true, otherResult, undefined, {
      channel: "reef",
    });
  });
});

describe("conversations.turn Gateway handler", () => {
  it("rejects a source session owned by another agent", async () => {
    const runConversationTurn = vi.mocked(runGatewayConversationTurn);
    const handler = conversationHandlers["conversations.turn"]!;
    const respond = vi.fn<RespondFn>();

    await invoke({
      handler,
      context: context(),
      respond,
      request: { ...request, sourceSessionKey: "agent:ops:main" },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining("ops") }),
    );
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("validates requests before entering the correlation service", async () => {
    const runConversationTurn = vi.mocked(runGatewayConversationTurn);
    const handler = conversationHandlers["conversations.turn"]!;
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: context(), respond, request: { agentId: "main" } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("joins concurrent retries and replays the completed idempotent result", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const runConversationTurn = vi.mocked(runGatewayConversationTurn).mockImplementation(
      async () =>
        await new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = conversationHandlers["conversations.turn"]!;
    const gatewayContext = context();
    const firstRespond = vi.fn<RespondFn>();
    const secondRespond = vi.fn<RespondFn>();
    const first = invoke({ handler, context: gatewayContext, respond: firstRespond });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());
    expect(runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    const timeoutMismatchRespond = vi.fn<RespondFn>();
    await invoke({
      handler,
      context: gatewayContext,
      respond: timeoutMismatchRespond,
      request: { ...request, timeoutMs: 5_000 },
    });
    expect(timeoutMismatchRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    const second = invoke({ handler, context: gatewayContext, respond: secondRespond });
    finish?.(result);
    await Promise.all([first, second]);

    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(firstRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
    expect(secondRespond).toHaveBeenCalledWith(true, result, undefined, {
      channel: "reef",
      cached: true,
    });

    const cachedRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: cachedRespond });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(cachedRespond).toHaveBeenCalledWith(true, result, undefined, { cached: true });

    for (const key of gatewayContext.dedupe.keys()) {
      if (key.endsWith(":identity")) {
        gatewayContext.dedupe.delete(key);
      }
    }
    const mismatchedRespond = vi.fn<RespondFn>();
    await invoke({
      handler,
      context: gatewayContext,
      respond: mismatchedRespond,
      request: { ...request, message: "different message" },
    });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(mismatchedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps concurrent turn IDs isolated between agents", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const otherResult = { ...result, messageId: "reef-outbound-other" };
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockImplementation(async ({ agentId }: Parameters<typeof runGatewayConversationTurn>[0]) =>
        agentId === "main"
          ? await new Promise<typeof result>((resolve) => {
              finish = resolve;
            })
          : otherResult,
      );
    const handler = conversationHandlers["conversations.turn"]!;
    const gatewayContext = context();
    const firstRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();
    const first = invoke({ handler, context: gatewayContext, respond: firstRespond });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());

    const other = invoke({
      handler,
      context: gatewayContext,
      respond: otherRespond,
      request: {
        ...request,
        agentId: "other-agent",
        sourceSessionKey: "agent:other-agent:telegram:direct:operator",
      },
    });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledTimes(2));
    finish?.(result);
    await Promise.all([first, other]);

    expect(firstRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
    expect(otherRespond).toHaveBeenCalledWith(true, otherResult, undefined, {
      channel: "reef",
    });
  });

  it("retries transient unavailable failures instead of caching them", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce(result);
    const handler = conversationHandlers["conversations.turn"]!;
    const gatewayContext = context();
    const failedRespond = vi.fn<RespondFn>();

    await invoke({ handler, context: gatewayContext, respond: failedRespond });
    expect(failedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
      expect.any(Object),
    );

    const retryRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: retryRespond });
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expect(retryRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
  });

  it("does not let a durable operation conflict poison the authoritative retry identity", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockRejectedValueOnce(
        new ConversationOperationConflictError(
          `Conversation delivery operation was reused with different input: ${request.turnId}`,
        ),
      )
      .mockResolvedValueOnce(result);
    const handler = conversationHandlers["conversations.turn"]!;
    const gatewayContext = context();
    const conflictRespond = vi.fn<RespondFn>();

    await invoke({
      handler,
      context: gatewayContext,
      respond: conflictRespond,
      request: { ...request, message: "conflicting message" },
    });
    expect(conflictRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
      expect.any(Object),
    );
    expect([...gatewayContext.dedupe.keys()].some((key) => key.endsWith(":identity"))).toBe(false);

    const authoritativeRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: authoritativeRespond });
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expect(authoritativeRespond).toHaveBeenCalledWith(true, result, undefined, {
      channel: "reef",
    });
  });

  it("maps unsupported conversation input to a stable invalid-request response", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockImplementation(async () => {
        throw new ConversationInputError("Channel matrix does not support correlated turns");
      });
    const handler = conversationHandlers["conversations.turn"]!;
    const gatewayContext = context();
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: gatewayContext, respond });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Channel matrix does not support correlated turns",
      }),
      expect.any(Object),
    );

    const retryRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: retryRespond });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(retryRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Channel matrix does not support correlated turns",
      }),
      { cached: true },
    );
  });

  it("cancels an abandoned turn through the active Gateway connection", async () => {
    const cancelConversationTurn = vi
      .mocked(cancelPendingConversationTurn)
      .mockImplementation(() => true);
    const handler = conversationHandlers["conversations.turn.cancel"]!;
    const respond = vi.fn<RespondFn>();

    await handler({
      params: { agentId: request.agentId, turnId: request.turnId },
      respond,
      context: context(),
      req: { type: "req", id: "2", method: "conversations.turn.cancel" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(cancelConversationTurn).toHaveBeenCalledWith({
      agentId: request.agentId,
      id: request.turnId,
    });
    expect(respond).toHaveBeenCalledWith(true, { cancelled: true }, undefined);
  });
});
