/**
 * Gateway tool-resolution tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps webchat room-event turns on automatic source delivery", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("force-allows the message tool for routed webchat room-event turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("passes loopback yield context into sessions_yield", async () => {
    const onYield = vi.fn();
    addSubagentRunForTests({
      runId: "run-loopback-yield-child",
      childSessionKey: "agent:main:subagent:loopback-yield-child",
      requesterSessionKey: "agent:main:telegram:group:-100123",
      requesterDisplayKey: "telegram:group:-100123",
      task: "finish bounded child work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    } satisfies SubagentRunRecord);
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-123",
      onYield,
      surface: "loopback",
    });
    const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
    if (!yieldTool) {
      throw new Error("expected sessions_yield tool");
    }

    const toolResult = await yieldTool.execute("tool-call-1", {
      message: "waiting on subagents",
    });

    expect(onYield).toHaveBeenCalledWith("waiting on subagents");
    expect(toolResult.details).toEqual({
      status: "yielded",
      message: "waiting on subagents",
    });
  });

  it("rejects loopback yield when the session has no pending descendants", async () => {
    const onYield = vi.fn();
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-no-descendants",
      onYield,
      surface: "loopback",
    });
    const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
    if (!yieldTool) {
      throw new Error("expected sessions_yield tool");
    }

    const toolResult = await yieldTool.execute("tool-call-no-descendants", {});

    expect(onYield).not.toHaveBeenCalled();
    expect(toolResult.details).toEqual({
      status: "error",
      error: expect.stringContaining("no descendant work"),
    });
  });
});
