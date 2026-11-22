import { expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-error.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { finalizeChatSendDispatchedReplies } from "./chat-send-reply-finalization.js";

const fake = vi.hoisted(() => ({
  readSession: vi.fn(),
  readPlacement: vi.fn(),
  appendAssistant: vi.fn(),
}));

// mock-isolation: Session, optional placement, and transcript I/O use synthetic values only.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: fake.readSession,
}));
vi.mock("../session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: () => new Map(),
      getManyAsync: fake.readPlacement,
    },
  }),
}));
vi.mock("./chat-transcript-inject.js", () => ({
  appendInjectedAssistantMessageToTranscript: fake.appendAssistant,
}));

it("publishes a settled plain-text reply without the optional placement worker", async () => {
  const sessionKey = "agent:main:plain-reply";
  const sessionId = "synthetic-session";
  const runId = "synthetic-plain-reply";
  const text = "The ordinary reply was completed.";
  const cfg = {};
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const persistUserTurnTranscript = vi.fn(async () => undefined);
  fake.readSession.mockResolvedValue({
    entry: { sessionId, updatedAt: 1, sessionRoot: "/synthetic/workspace" },
    storePath: "/synthetic/sessions.sqlite",
  });
  fake.readPlacement.mockRejectedValue(
    new SqliteWorkerError("Synthetic placement worker unavailable", "unavailable"),
  );
  fake.appendAssistant.mockResolvedValue({
    ok: true,
    messageId: "synthetic-reply",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  await finalizeChatSendDispatchedReplies({
    accountId: undefined,
    context,
    deliveredReplies: [{ kind: "final", input: { kind: "raw", payload: { text } } }],
    emitFirstAssistantServerTiming: vi.fn(),
    foldCommandBlocks: false,
    persistUserTurnTranscript,
    session: {
      agentId: "main",
      backingSessionId: sessionId,
      cfg,
      clientRunId: runId,
      sessionKey,
      sessionLoadOptions: { agentId: "main" },
    },
    state: "final",
    suppressReplies: false,
    terminalEntry: undefined,
  });

  expect(fake.readPlacement).not.toHaveBeenCalled();
  expect(persistUserTurnTranscript).toHaveBeenCalledOnce();
  expect(fake.appendAssistant).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey, sessionId, message: text, idempotencyKey: runId }),
  );
  expect(context.broadcast).toHaveBeenCalledExactlyOnceWith(
    "chat",
    expect.objectContaining({
      runId,
      sessionKey,
      state: "final",
      message: expect.objectContaining({ content: [{ type: "text", text }] }),
    }),
    expect.anything(),
  );
});
