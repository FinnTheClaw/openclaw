/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestIdleCallback", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat send acknowledgment run ownership", () => {
  it.each(["started", "ok", "error", "timeout"] as const)(
    "preserves the active model run when a steering send acknowledges %s",
    async (status) => {
      const tool = { role: "toolResult", toolCallId: "active-tool", content: "still running" };
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": (params: { idempotencyKey: string }) => ({
            runId: params.idempotencyKey,
            status,
          }),
          "chat.history": () => new Promise(() => {}),
        },
        chatMessage: "tighten the plan",
        chatRunId: "active-model-run",
        chatStream: "Working on the active model run",
        chatStreamSegments: [{ text: "Existing commentary", ts: 1, runId: "active-model-run" }],
        chatToolMessages: [tool],
        sessionKey: "agent:main:main",
        settings: { chatFollowUpMode: "steer" },
      });

      await handleSendChat(host);
      expect(findChatSendPayload(host).queueMode).toBe("steer");
      expect(host.chatRunId).toBe("active-model-run");
      expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
      expect(host.chatStream).toBe("Working on the active model run");
      expect(host.chatToolMessages).toEqual([tool]);
      expect(host.chatStreamSegments).toEqual([
        { text: "Existing commentary", ts: 1, runId: "active-model-run" },
      ]);
      if (status === "error" || status === "timeout") {
        expect(host.chatQueue[0]?.sendState).toBe("failed");
      } else if (status === "ok") {
        expect(host.chatQueue).toEqual([]);
      }
    },
  );

  it.each(["ok", "error", "timeout"] as const)(
    "preserves a newer live run when an older send acknowledges %s",
    async (status) => {
      const ack = createDeferred<{ runId: string; status: typeof status }>();
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": () => ack.promise,
          "chat.history": () => new Promise(() => {}),
        },
        chatMessage: "first request",
        sessionKey: "agent:main:main",
      });
      const sending = handleSendChat(host);
      await waitForFast(() =>
        expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything()),
      );
      const runId = String(findChatSendPayload(host).idempotencyKey);
      handleChatGatewayEvent(host, {
        sessionKey: host.sessionKey,
        runId: "successor-run",
        state: "delta",
        deltaText: "Newer work is streaming",
      });
      expect(host.chatRunId).toBe("successor-run");
      ack.resolve({ runId, status });
      await sending;

      expect(host.chatRunId).toBe("successor-run");
      expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
      expect(host.chatStream).toBe("Newer work is streaming");
      if (status === "error" || status === "timeout") {
        expect(host.chatQueue[0]?.sendState).toBe("failed");
      } else {
        expect(host.chatQueue).toEqual([]);
      }
    },
  );

  it.each(
    (["ok", "error", "timeout"] as const).flatMap((status) =>
      (["matching", "absent"] as const).map((owner) => ({ status, owner })),
    ),
  )("retires a $owner current run for its $status ACK", async ({ status, owner }) => {
    const ack = createDeferred<{ runId: string; status: typeof status }>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => ack.promise,
        "chat.history": () => new Promise(() => {}),
      },
      chatMessage: "owned request",
      sessionKey: "agent:main:main",
    });
    const sending = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything()),
    );
    const runId = String(findChatSendPayload(host).idempotencyKey);
    if (owner === "matching") {
      handleChatGatewayEvent(host, {
        sessionKey: host.sessionKey,
        runId,
        state: "delta",
        deltaText: "Owned work",
      });
      expect(host.chatRunId).toBe(runId);
    }
    ack.resolve({ runId, status });
    await sending;

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatSending).toBe(false);
    if (status === "error" || status === "timeout") {
      expect(host.chatQueue[0]?.sendState).toBe("failed");
    } else {
      expect(host.chatQueue).toEqual([]);
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything());
    }
  });

  it("preserves a successor that starts while owned terminal history is pending", async () => {
    const history = createDeferred<{ messages: unknown[] }>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: { idempotencyKey: string }) => ({
          runId: params.idempotencyKey,
          status: "ok",
        }),
        "chat.history": () => history.promise,
      },
      chatMessage: "completed request",
      sessionKey: "agent:main:main",
    });
    await handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    handleChatGatewayEvent(host, {
      sessionKey: host.sessionKey,
      runId: "successor-after-history-start",
      state: "delta",
      deltaText: "Keep this newer live output",
    });
    history.resolve({ messages: [] });
    await waitForFast(() => expect(host.chatLoading).toBe(false));

    expect(host.chatRunId).toBe("successor-after-history-start");
    expect(host.chatStream).toBe("Keep this newer live output");
  });
});
