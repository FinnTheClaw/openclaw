import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import * as heartbeatWake from "./heartbeat-wake.js";

describe("heartbeat broadcast outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetHeartbeatEventsForTest();
  });

  afterEach(async () => {
    // A failed assertion must not leave retained work for the next runner.
    const dispose = heartbeatWake.setHeartbeatWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    await vi.runAllTimersAsync();
    dispose();
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startRunner() {
    const register = vi.spyOn(heartbeatWake, "setHeartbeatWakeHandler");
    const runOnce = vi
      .fn<NonNullable<Parameters<typeof startHeartbeatRunner>[0]["runOnce"]>>()
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    } as OpenClawConfig;
    const runner = startHeartbeatRunner({ cfg, runOnce });
    onTestFinished(() => runner.stop());
    const run = register.mock.calls.at(-1)?.[0];
    if (!run) {
      throw new Error("Expected the runner to register a wake handler");
    }
    return { run, runOnce, runner };
  }

  it("retains an untargeted task through min-spacing and dispatches its payload at the deadline", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const wake = {
      source: "cron",
      intent: "task",
      reason: "heartbeat-task:inbox",
      tasks: [{ jobId: "inbox", name: "Inbox", prompt: "Check inbox" }],
    } as const;

    expect.soft(await run(wake)).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
      broadcastResults: ["main", "ops"].map((agentId) => ({
        agentId,
        result: { status: "skipped", reason: "min-spacing", retryAtMs: 30_000 },
      })),
    });
    expect(getLastHeartbeatEvent()).toBeNull();
    heartbeatWake.requestHeartbeat({ ...wake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(29_998);
    expect(runOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(
      runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual(["main", "ops"].map((agentId) => ({ agentId, tasks: wake.tasks })));
  });

  it.each([
    { intent: "task", reason: "min-spacing", runs: 1, retryAtMs: 30_000 },
    { intent: "scheduled", reason: "not-due", runs: 1, retryAtMs: 30 * 60_000 },
    { intent: "immediate", reason: "flood", runs: 5, retryAtMs: 60_001 },
  ] as const)("preserves the earliest $reason deadline across agents", async (testCase) => {
    const { run } = startRunner();
    for (let i = 0; i < testCase.runs; i++) {
      await run({ source: "manual", intent: "manual", agentId: "ops" });
    }
    vi.setSystemTime(5_000);
    for (let i = 0; i < testCase.runs; i++) {
      await run({ source: "manual", intent: "manual", agentId: "main" });
    }
    vi.setSystemTime(10_000);

    expect(await run({ source: "interval", intent: testCase.intent, reason: "interval" })).toEqual({
      status: "skipped",
      reason: testCase.reason,
      retryAtMs: testCase.retryAtMs,
      broadcastResults: ["main", "ops"].map((agentId) => ({
        agentId,
        result: {
          status: "skipped",
          reason: testCase.reason,
          retryAtMs: testCase.retryAtMs + (agentId === "main" ? 5_000 : 0),
        },
      })),
    });
  });

  it.each([
    { status: "skipped", reason: "quiet-hours" },
    { status: "failed", reason: "agent-tool-failure" },
  ] as const)("prefers a guard deferral over a sibling $reason outcome", async (terminal) => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    vi.setSystemTime(1);
    runOnce.mockResolvedValue(terminal);

    expect(await run({ source: "cron", intent: "task" })).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
      broadcastResults: [
        { agentId: "main", result: terminal },
        {
          agentId: "ops",
          result: { status: "skipped", reason: "min-spacing", retryAtMs: 30_000 },
        },
      ],
    });
  });

  it.each([
    { status: "skipped", reason: "quiet-hours" },
    { status: "failed", reason: "agent-tool-failure" },
  ] as const)("preserves the first $reason outcome when no agent can retry", async (result) => {
    const { run, runOnce } = startRunner();
    runOnce
      .mockResolvedValueOnce(result)
      .mockResolvedValue({ status: "skipped", reason: "disabled" });

    expect(await run({ source: "cron", intent: "task" })).toEqual(result);
  });

  it("preserves the busy retry fast path even when another agent ran", async () => {
    const { run, runOnce } = startRunner();
    const busy = {
      status: "skipped",
      reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
    } as const;
    runOnce.mockResolvedValueOnce(busy);

    expect(await run({ source: "cron", intent: "task" })).toEqual({
      ...busy,
      broadcastResults: [
        { agentId: "main", result: busy },
        { agentId: "ops", result: { status: "ran", durationMs: 1 } },
      ],
    });
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("delivers a broadcast task to the deferred agent without repeating its completed sibling", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const tasks = [{ jobId: "inbox", name: "Inbox", prompt: "Check inbox" }];

    heartbeatWake.requestHeartbeat({
      source: "cron",
      intent: "task",
      tasks,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main"]);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main", "ops"]);
    expect(runOnce.mock.calls.map(([opts]) => opts.tasks)).toEqual([tasks, tasks]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it.each(["manual", "immediate"] as const)(
    "retries only the busy broadcast agent for %s intent",
    async (intent) => {
      const { runOnce } = startRunner();
      const attempts = new Map<string, number>();
      runOnce.mockImplementation(async ({ agentId }) => {
        const count = (attempts.get(agentId!) ?? 0) + 1;
        attempts.set(agentId!, count);
        return agentId === "ops" && count === 1
          ? { status: "skipped", reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT }
          : { status: "ran", durationMs: 1 };
      });

      heartbeatWake.requestHeartbeat({ source: "manual", intent, coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main", "ops"]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main", "ops", "ops"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runOnce).toHaveBeenCalledTimes(3);
    },
  );

  it("coalesces later work only for the deferred target and waits for its settlement", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const original = { jobId: "a", name: "First", prompt: "Original work" };
    const later = { jobId: "b", name: "Second", prompt: "Later work" };
    let settled = false;
    const done = heartbeatWake
      .requestHeartbeatAndWait({
        source: "cron",
        intent: "task",
        tasks: [original],
        coalesceMs: 0,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    heartbeatWake.requestHeartbeat({
      source: "cron",
      intent: "task",
      agentId: "ops",
      tasks: [later],
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(29_997);
    expect(settled).toBe(false);
    expect(
      runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual([{ agentId: "main", tasks: [original] }]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await done).toMatchObject({ status: "ran" });
    expect(
      runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual([
      { agentId: "main", tasks: [original] },
      { agentId: "ops", tasks: [original, later] },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("retains independent broadcast deadlines without replaying the earlier target", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "main" });
    vi.setSystemTime(5_000);
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    runOnce.mockClear();
    vi.setSystemTime(10_000);
    let settled = false;
    const done = heartbeatWake
      .requestHeartbeatAndWait({
        source: "cron",
        intent: "task",
        tasks: [{ jobId: "a", name: "Work", prompt: "Both targets" }],
        coalesceMs: 0,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main"]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await done).toMatchObject({ status: "ran" });
    expect(runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main", "ops"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("hands only unfinished broadcast targets to a replacement runner", async () => {
    const first = startRunner();
    await first.run({ source: "manual", intent: "manual", agentId: "ops" });
    first.runOnce.mockClear();
    vi.setSystemTime(1);
    const tasks = [{ jobId: "a", name: "Work", prompt: "Retained on replacement" }];
    let settled = false;
    const done = heartbeatWake
      .requestHeartbeatAndWait({
        source: "cron",
        intent: "task",
        tasks,
        coalesceMs: 0,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(1);
    expect(first.runOnce.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main"]);
    expect(settled).toBe(false);

    first.runner.stop();
    const second = startRunner();
    await vi.advanceTimersByTimeAsync(250);

    expect(await done).toMatchObject({ status: "ran" });
    expect(
      second.runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual([{ agentId: "ops", tasks }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.runOnce).toHaveBeenCalledTimes(1);
    expect(second.runOnce).toHaveBeenCalledTimes(1);
  });

  it("retries a channel-not-ready alert without consuming its scheduled cadence", async () => {
    const { run, runOnce } = startRunner();
    runOnce.mockResolvedValueOnce({
      status: "skipped",
      reason: "channel-not-ready",
      retryAtMs: 60_000,
    });
    const wake = {
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
    } as const;
    heartbeatWake.requestHeartbeat({ ...wake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(await run(wake)).toMatchObject({ status: "skipped", reason: "not-due" });
  });
});
