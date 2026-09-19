import { describe, expect, it } from "vitest";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

describe("partially visible tool call ownership", () => {
  it.each([
    { name: "explicit conflicting run", segmentRunId: "run-a", boundaryRunId: "steer-a" },
    { name: "matching owner control", segmentRunId: "run-b", boundaryRunId: "steer-b" },
    { name: "legacy unscoped control", segmentRunId: undefined, boundaryRunId: "steer-b" },
  ])("resolves tool boundaries for $name", ({ name, segmentRunId, boundaryRunId }) => {
    const paneId = `tool-owner-audit:${name}`;
    try {
      const items = buildCachedChatItems({
        paneId,
        sessionKey: "main",
        runId: "run-b",
        messages: [
          {
            role: "user",
            content: "Run A",
            timestamp: 100,
            __openclaw: { idempotencyKey: "run-a:user" },
          },
          {
            role: "user",
            content: "Steer A",
            timestamp: 200,
            __openclaw: { idempotencyKey: "steer-a:user" },
          },
          {
            role: "user",
            content: "Run B",
            timestamp: 300,
            __openclaw: { idempotencyKey: "run-b:user" },
          },
          {
            role: "user",
            content: "Steer B",
            timestamp: 400,
            __openclaw: { idempotencyKey: "steer-b:user" },
          },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "shared-call",
            toolName: "shell",
            content: "Run B tool",
            timestamp: 350,
            runId: "run-b",
          },
        ],
        streamSegments: [
          { text: "", ts: 150, runId: segmentRunId, toolCallId: "shared-call", boundaryRunId },
        ],
        stream: null,
        streamStartedAt: null,
        showToolCalls: true,
      });
      const order = items.flatMap((item) =>
        item.kind === "group"
          ? item.role === "tool"
            ? ["tool"]
            : item.messages.map(({ message }) => (message as { content: string }).content)
          : [],
      );
      expect(order).toEqual(["Run A", "Steer A", "Run B", "tool", "Steer B"]);
    } finally {
      resetChatThreadState(paneId);
    }
  });
});
