import { describe, expect, it, vi } from "vitest";
import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";
import { C02_RESTART_REGISTRATION } from "./governor-c02-restart-guard.js";

function run(sessionKey: string) {
  return {
    runId: "run-1",
    sessionKey,
    sessionId: "stable-session",
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: "stable-session",
    sourceMessageId: "stable-source",
    sourceSequence: 1,
    prompt: "C02 evaluation",
    now: 10,
  } as const;
}

function scope(
  ticket = Object.freeze({ opaque: {} }),
  afterTool: GovernorAgentLoopRunScope["afterTool"] = vi.fn(),
): GovernorAgentLoopRunScope {
  return {
    taskId: "task-1",
    mode: "enforce",
    disposition: "runnable",
    beforeTool: vi.fn(() => ({ kind: "allow", ticket })),
    afterTool,
    afterTurn: vi.fn(() => ({ kind: "complete" })),
    interrupt: vi.fn(),
    assertTerminal: vi.fn(),
    governedTools: vi.fn(() => []),
    dispose: vi.fn(),
  };
}

function host(processInstanceId: string, events: Array<Record<string, unknown>>) {
  const recordRuntimeEvent = vi.fn((event: Record<string, unknown>) => {
    events.push({ eventType: event.eventType, payload: event.payload });
  });
  const registration = C02_RESTART_REGISTRATION.bind({
    processInstanceId,
    controller: { recordRuntimeEvent },
    store: { listEvents: () => events },
    capabilities: [],
    seal: vi.fn(),
  } as never);
  return { registration, recordRuntimeEvent };
}

function wrap(
  registration: ReturnType<typeof C02_RESTART_REGISTRATION.bind>,
  sessionKey: string,
  underlying = scope(),
) {
  return registration.wrap({
    scope: underlying,
    run: run(sessionKey),
    config: {},
    modulePlanDigest: "a".repeat(64),
    hostDescriptorDigest: "b".repeat(64),
  } as never);
}

async function observeB(guarded: GovernorAgentLoopRunScope, signal?: AbortSignal, isError = false) {
  const decision = guarded.beforeTool({
    toolCallId: "tool-b",
    toolName: "read",
    args: { path: "/case/C02-F-001/beta.txt" },
    tool: undefined,
    now: 11,
  });
  if (decision.kind !== "allow") {
    throw new Error("expected beta admission");
  }
  return guarded.afterTool({
    ticket: decision.ticket,
    toolCallId: "tool-b",
    toolName: "read",
    result: "beta",
    isError,
    ...(signal ? { signal } : {}),
    now: 12,
  });
}

describe("C02 restart guard", () => {
  it("leaves every non-F evaluation scope unchanged", () => {
    const events: Array<Record<string, unknown>> = [];
    const test = host("process-1", events);
    const underlying = scope();

    expect(wrap(test.registration, "c02-eval:C02-A-001:111111111111111111111111", underlying)).toBe(
      underlying,
    );

    test.registration.close();
  });

  it("persists restart-required state and fails closed without an abort signal", async () => {
    const events: Array<Record<string, unknown>> = [];
    const test = host("process-1", events);
    const guarded = wrap(test.registration, "c02-eval:C02-F-001:222222222222222222222222");

    await expect(observeB(guarded)).rejects.toThrow("C02_RESTART_SIGNAL_REQUIRED");
    expect(guarded.disposition).toBe("checkpoint_pending");
    expect(events).toContainEqual({
      eventType: "runtime_tool_observed",
      payload: {
        kind: "c02_restart_required",
        moduleId: "c02-simple-efficiency",
        processInstanceId: "process-1",
      },
    });

    guarded.dispose();
    test.registration.close();
  });

  it("blocks same-process re-resolution after B", async () => {
    const events: Array<Record<string, unknown>> = [];
    const firstHost = host("process-1", events);
    const first = wrap(firstHost.registration, "c02-eval:C02-F-001:333333333333333333333333");
    await expect(observeB(first)).rejects.toThrow("C02_RESTART_SIGNAL_REQUIRED");
    first.dispose();

    const sameProcess = wrap(firstHost.registration, "c02-eval:C02-F-001:333333333333333333333333");
    expect(sameProcess.disposition).toBe("checkpoint_pending");
    expect(
      sameProcess.beforeTool({
        toolCallId: "tool-aggregate",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 13,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_RESTART_REQUIRED" });

    sameProcess.dispose();
    firstHost.registration.close();
  });

  it("blocks an already-open same-process scope as soon as another scope arms B", async () => {
    const events: Array<Record<string, unknown>> = [];
    const test = host("process-1", events);
    const session = "c02-eval:C02-F-001:666666666666666666666666";
    const first = wrap(test.registration, session);
    const overlapping = wrap(test.registration, session);
    const controller = new AbortController();

    const pending = observeB(first, controller.signal);
    expect(overlapping.disposition).toBe("checkpoint_pending");
    expect(
      overlapping.beforeTool({
        toolCallId: "tool-aggregate",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 13,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_RESTART_REQUIRED" });

    controller.abort();
    await pending;
    first.dispose();
    overlapping.dispose();
    test.registration.close();
  });

  it("durably arms the restart before the generic B outcome can commit", async () => {
    const events: Array<Record<string, unknown>> = [];
    const timeline: string[] = [];
    const test = host("process-1", events);
    const underlying = scope(
      undefined,
      vi.fn(() => timeline.push("outcome")),
    );
    test.recordRuntimeEvent.mockImplementation((event: Record<string, unknown>) => {
      timeline.push("marker");
      events.push({ eventType: event.eventType, payload: event.payload });
    });
    const guarded = wrap(
      test.registration,
      "c02-eval:C02-F-001:777777777777777777777777",
      underlying,
    );
    const controller = new AbortController();
    controller.abort();

    await observeB(guarded, controller.signal);
    expect(timeline).toEqual(["marker", "outcome"]);

    guarded.dispose();
    test.registration.close();
  });

  it("does not arm a restart when the admitted B observation fails", async () => {
    const events: Array<Record<string, unknown>> = [];
    const underlyingAfterTool = vi.fn();
    const test = host("process-1", events);
    const guarded = wrap(
      test.registration,
      "c02-eval:C02-F-001:888888888888888888888888",
      scope(undefined, underlyingAfterTool),
    );

    await observeB(guarded, undefined, true);
    expect(underlyingAfterTool).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(guarded.disposition).toBe("runnable");

    guarded.dispose();
    test.registration.close();
  });

  it("allows resume only under a changed gateway process instance", async () => {
    const events: Array<Record<string, unknown>> = [
      {
        eventType: "runtime_tool_observed",
        payload: {
          kind: "c02_restart_required",
          moduleId: "c02-simple-efficiency",
          processInstanceId: "process-1",
        },
      },
    ];
    const restartedHost = host("process-2", events);
    const resumed = wrap(restartedHost.registration, "c02-eval:C02-F-001:444444444444444444444444");

    expect(resumed.disposition).toBe("runnable");
    expect(
      resumed.beforeTool({
        toolCallId: "tool-aggregate",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 13,
      }),
    ).toMatchObject({ kind: "allow" });
    expect(events).toContainEqual({
      eventType: "runtime_tool_observed",
      payload: {
        kind: "c02_restart_resumed",
        moduleId: "c02-simple-efficiency",
        processInstanceId: "process-2",
        requiredProcessInstanceId: "process-1",
      },
    });

    resumed.dispose();
    restartedHost.registration.close();
  });

  it("keeps an older process blocked after a successor also requires restart", async () => {
    const events: Array<Record<string, unknown>> = [];
    const firstHost = host("process-1", events);
    const first = wrap(firstHost.registration, "c02-eval:C02-F-001:999999999999999999999999");
    const firstAbort = new AbortController();
    firstAbort.abort();
    await observeB(first, firstAbort.signal);

    const secondHost = host("process-2", events);
    const second = wrap(secondHost.registration, "c02-eval:C02-F-001:999999999999999999999999");
    const secondAbort = new AbortController();
    secondAbort.abort();
    await observeB(second, secondAbort.signal);

    expect(first.disposition).toBe("checkpoint_pending");
    expect(
      first.beforeTool({
        toolCallId: "tool-stale-aggregate",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 14,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_RESTART_REQUIRED" });

    second.dispose();
    secondHost.registration.close();
    first.dispose();
    firstHost.registration.close();
  });

  it("settles a pending restart wait when its scope closes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const test = host("process-1", events);
    const guarded = wrap(test.registration, "c02-eval:C02-F-001:555555555555555555555555");
    const controller = new AbortController();
    const pending = observeB(guarded, controller.signal);
    await Promise.resolve();

    expect(guarded.disposition).toBe("checkpoint_pending");
    guarded.dispose();
    await pending;

    test.registration.close();
  });
});
