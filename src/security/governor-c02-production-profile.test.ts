import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import {
  C02_REDUNDANT_SUCCESSFUL_TOOL_CALL,
  createGovernorC02ProductionProfileScope,
} from "./governor-c02-production-profile.js";

function scope(runId = "run-1") {
  return createGovernorC02ProductionProfileScope({
    runId,
    sessionKey: `session-${runId}`,
    sessionId: `session-${runId}`,
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: `conversation-${runId}`,
    sourceMessageId: `message-${runId}`,
    prompt: "ordinary request",
    now: 1,
  });
}

function allowed(
  target: ReturnType<typeof scope>,
  toolName: string,
  args: unknown,
  toolCallId = "tool-1",
) {
  return target.beforeTool({ toolCallId, toolName, args, tool: undefined, now: 2 });
}

function successful(
  target: ReturnType<typeof scope>,
  decision: ReturnType<typeof allowed>,
  toolName: string,
  toolCallId = "tool-1",
) {
  expect(decision.kind).toBe("allow");
  target.afterTool({
    ...(decision.kind === "allow" && decision.ticket ? { ticket: decision.ticket } : {}),
    toolCallId,
    toolName,
    result: { ignored: true },
    isError: false,
    now: 3,
  });
}

function failed(
  target: ReturnType<typeof scope>,
  decision: ReturnType<typeof allowed>,
  toolName: string,
) {
  target.afterTool({
    ...(decision.kind === "allow" && decision.ticket ? { ticket: decision.ticket } : {}),
    toolCallId: "tool-failed",
    toolName,
    result: { ignored: true },
    isError: true,
    now: 3,
  });
}

describe("C02 ordinary-session production profile", () => {
  it("blocks only the immediate exact replay of a successful call", () => {
    const target = scope();
    successful(target, allowed(target, "read", { path: "/a" }), "read");

    expect(allowed(target, "read", { path: "/a" }, "duplicate")).toEqual({
      kind: "block",
      reasonCode: C02_REDUNDANT_SUCCESSFUL_TOOL_CALL,
    });
    expect(allowed(target, "read", { path: "/b" }, "different").kind).toBe("allow");
  });

  it("canonicalizes safe object keys but not unsafe arguments", () => {
    const target = scope();
    successful(target, allowed(target, "exec", { alpha: 1, beta: [true, null] }), "exec");
    expect(allowed(target, "exec", { beta: [true, null], alpha: 1 }).kind).toBe("block");

    const unsafe = Object.create(null) as Record<string, unknown>;
    unsafe.path = "/a";
    expect(allowed(target, "read", unsafe).kind).toBe("allow");
    expect(allowed(target, "read", unsafe).kind).toBe("allow");
  });

  it("does not cache failures and lets their retry through", () => {
    const target = scope();
    const first = allowed(target, "read", { path: "/a" });
    failed(target, first, "read");
    expect(allowed(target, "read", { path: "/a" }).kind).toBe("allow");
  });

  it("invalidates a successful-call candidate after every other admitted call", () => {
    const target = scope();
    successful(target, allowed(target, "read", { path: "/a" }), "read");
    failed(target, allowed(target, "read", { path: "/b" }, "other"), "read");
    expect(allowed(target, "read", { path: "/a" }, "retry-old").kind).toBe("allow");
  });

  it("keeps concurrent runs and their candidates isolated", () => {
    const first = scope("first");
    const second = scope("second");
    successful(first, allowed(first, "read", { path: "/a" }), "read");
    expect(allowed(second, "read", { path: "/a" }).kind).toBe("allow");
    expect(allowed(first, "read", { path: "/a" }).kind).toBe("block");
  });

  it("keeps no state across runs, sessions, or disposal", () => {
    const first = scope("before-restart");
    successful(first, allowed(first, "read", { path: "/a" }), "read");
    first.dispose();
    const resumed = scope("after-restart");
    expect(allowed(resumed, "read", { path: "/a" }).kind).toBe("allow");
  });

  it("preserves an arbitrary installed tool inventory and tool types", () => {
    const target = scope();
    const tools = Object.freeze([
      { name: "read", execute: async () => "ok" },
      { name: "browser", execute: async () => "ok" },
      { name: "custom", execute: async () => "ok" },
    ]) as unknown as readonly AgentTool[];
    target.prepareTools?.(tools);
    expect(target.governedTools()).toEqual(tools);
    expect(target.governedTools()[1]).toBe(tools[1]);
  });

  it("emits exactly one bounded reactive continuation for blocked duplicates", () => {
    const target = scope();
    successful(target, allowed(target, "read", { path: "/a" }), "read");
    allowed(target, "read", { path: "/a" }, "duplicate-one");
    allowed(target, "read", { path: "/a" }, "duplicate-two");

    expect(target.afterTurn({ assistantText: "", toolCallCount: 0, now: 4 })).toEqual({
      kind: "continue",
      message: "A duplicate successful tool call was blocked. Continue with a different action.",
    });
    expect(target.afterTurn({ assistantText: "", toolCallCount: 0, now: 5 })).toEqual({
      kind: "complete",
    });
  });

  it("does not advance state for a blocked duplicate", () => {
    const target = scope();
    successful(target, allowed(target, "read", { path: "/a" }), "read");
    expect(allowed(target, "read", { path: "/a" }).kind).toBe("block");
    expect(allowed(target, "read", { path: "/a" }).kind).toBe("block");
  });
});
