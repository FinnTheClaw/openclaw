import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import { registerC02Telemetry } from "./telemetry.js";

type Hook = (event: never, context: never) => unknown;

function registerTelemetry(loggerInfo = vi.fn()): {
  hooks: Map<string, Hook>;
  loggerInfo: ReturnType<typeof vi.fn>;
} {
  const hooks = new Map<string, Hook>();
  registerC02Telemetry({
    logger: { info: loggerInfo },
    on: (name: string, handler: Hook) => hooks.set(name, handler),
  } as unknown as OpenClawPluginApi);
  return { hooks, loggerInfo };
}

function hook(hooks: Map<string, Hook>, name: string): Hook {
  const registered = hooks.get(name);
  if (!registered) {
    throw new Error(`missing ${name} hook`);
  }
  return registered;
}

describe("registerC02Telemetry", () => {
  it("observes native calls and emits a run summary without result bodies", () => {
    const { hooks, loggerInfo } = registerTelemetry();
    const result = { privateResult: "do not log" };

    expect(
      hook(hooks, "after_tool_call")(
        {
          runId: "run-1",
          toolCallId: "tool-1",
          toolName: "read",
          params: {},
          result,
          durationMs: 12,
        } as never,
        { sessionId: "session-1", sessionKey: "key-1", agentId: "agent-1" } as never,
      ),
    ).toBeUndefined();
    expect(
      hook(hooks, "model_call_ended")(
        {
          runId: "run-1",
          callId: "call-1",
          provider: "local",
          model: "test-model",
          durationMs: 34,
          outcome: "completed",
        } as never,
        { sessionId: "session-1", sessionKey: "key-1", agentId: "agent-1" } as never,
      ),
    ).toBeUndefined();
    expect(
      hook(hooks, "llm_output")(
        {
          runId: "run-1",
          sessionId: "session-1",
          provider: "local",
          model: "test-model",
          assistantTexts: ["private assistant text"],
          usage: { input: 10, output: 5, cacheRead: 2 },
        } as never,
        { sessionKey: "key-1", agentId: "agent-1" } as never,
      ),
    ).toBeUndefined();
    expect(
      hook(hooks, "agent_end")(
        { runId: "run-1", messages: [result], success: true, durationMs: 60 } as never,
        { sessionId: "session-1", sessionKey: "key-1", agentId: "agent-1" } as never,
      ),
    ).toBeUndefined();

    const metrics = loggerInfo.mock.calls.map(([message]) => JSON.parse(message));
    expect(metrics).toEqual([
      expect.objectContaining({
        event: "c02.telemetry.tool_call",
        toolCallId: "tool-1",
        durationMs: 12,
      }),
      expect.objectContaining({ event: "c02.telemetry.model_call", callId: "call-1", durationMs: 34 }),
      expect.objectContaining({
        event: "c02.telemetry.llm_output",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: null, total: null },
      }),
      expect.objectContaining({
        event: "c02.telemetry.run_complete",
        toolCallCount: 1,
        modelCallCount: 1,
        durationMs: 60,
      }),
    ]);
    expect(loggerInfo.mock.calls.flat().join("\n")).not.toContain("private");
  });

  it("keeps usage independent when llm_output follows agent_end", () => {
    const { hooks, loggerInfo } = registerTelemetry();
    const context = { sessionId: "session-1" };
    const modelCall = {
      runId: "run-1",
      provider: "local",
      model: "test-model",
      outcome: "completed",
    };

    hook(hooks, "model_call_ended")({ ...modelCall, callId: "call-1" } as never, context as never);
    hook(hooks, "after_tool_call")(
      { runId: "run-1", toolCallId: "tool-1", toolName: "read" } as never,
      context as never,
    );
    hook(hooks, "model_call_ended")({ ...modelCall, callId: "call-2" } as never, context as never);
    hook(hooks, "agent_end")({ runId: "run-1", success: true } as never, context as never);
    hook(hooks, "llm_output")(
      { ...modelCall, sessionId: "session-1", usage: { input: 10, output: 5 } } as never,
      context as never,
    );

    const metrics = loggerInfo.mock.calls.map(([message]) => JSON.parse(message));
    expect(metrics.map((metric) => metric.event)).toEqual([
      "c02.telemetry.model_call",
      "c02.telemetry.tool_call",
      "c02.telemetry.model_call",
      "c02.telemetry.run_complete",
      "c02.telemetry.llm_output",
    ]);
    expect(metrics[3]).toMatchObject({ toolCallCount: 1, modelCallCount: 2 });
    expect(metrics[3]).not.toHaveProperty("llmOutputCount");
    expect(metrics[4]).toMatchObject({
      runId: "run-1",
      usage: { input: 10, output: 5, cacheRead: null, cacheWrite: null, total: null },
    });
  });

  it("swallows logger failures and does not alter tool results", () => {
    const { hooks } = registerTelemetry(vi.fn(() => {
      throw new Error("logger unavailable");
    }));
    const result = { value: "tool result" };

    expect(
      hook(hooks, "after_tool_call")(
        { toolName: "read", params: {}, result, durationMs: 1 } as never,
        { toolName: "read" } as never,
      ),
    ).toBeUndefined();
    expect(result).toEqual({ value: "tool result" });
  });
});
