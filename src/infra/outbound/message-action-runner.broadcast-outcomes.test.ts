// Verifies broadcast truth follows returned send deliveryStatus values.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import { workspaceConfig, workspaceTestPlugin } from "./message-action-runner.test-helpers.js";

const serviceMocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => serviceMocks);

function returnedSendResult(params: {
  deliveryStatus: "suppressed" | "failed" | "partial_failed";
  error?: string;
  messageId?: string;
}) {
  const sendResult = {
    channel: "workspace",
    to: "C123",
    via: "direct" as const,
    mediaUrl: null,
    deliveryStatus: params.deliveryStatus,
    ...(params.deliveryStatus === "suppressed"
      ? { suppressionReason: "cancelled_by_message_sending_hook" as const }
      : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.deliveryStatus === "partial_failed" ? { sentBeforeError: true } : {}),
    ...(params.messageId
      ? { result: { channel: "workspace" as const, messageId: params.messageId } }
      : {}),
  };
  return {
    handledBy: "core" as const,
    payload: sendResult,
    sendResult,
  };
}

async function runBroadcast() {
  return await runMessageAction({
    cfg: workspaceConfig,
    action: "broadcast",
    params: {
      channel: "workspace",
      targets: ["C123"],
      message: "hello",
    },
  });
}

describe("runMessageAction broadcast send outcomes", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "workspace", source: "test", plugin: workspaceTestPlugin }]),
    );
    serviceMocks.executeSendAction.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      deliveryStatus: "suppressed" as const,
      send: returnedSendResult({ deliveryStatus: "suppressed" }),
      error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
    },
    {
      deliveryStatus: "failed" as const,
      send: returnedSendResult({ deliveryStatus: "failed", error: "provider unavailable" }),
      error: "provider unavailable",
    },
  ])("maps returned $deliveryStatus to a failed broadcast entry", async ({ send, error }) => {
    serviceMocks.executeSendAction.mockResolvedValueOnce(send);

    await expect(runBroadcast()).resolves.toMatchObject({
      kind: "broadcast",
      payload: {
        results: [{ channel: "workspace", to: "C123", ok: false, error }],
      },
    });
  });

  it("retains a partial send's message ID and sent-before-error evidence", async () => {
    serviceMocks.executeSendAction.mockResolvedValueOnce(
      returnedSendResult({
        deliveryStatus: "partial_failed",
        error: "second payload failed",
        messageId: "partial-broadcast-1",
      }),
    );

    await expect(runBroadcast()).resolves.toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          {
            channel: "workspace",
            to: "C123",
            ok: false,
            error: "second payload failed",
            sentBeforeError: true,
            result: {
              deliveryStatus: "partial_failed",
              result: { messageId: "partial-broadcast-1" },
            },
          },
        ],
      },
    });
  });
});
