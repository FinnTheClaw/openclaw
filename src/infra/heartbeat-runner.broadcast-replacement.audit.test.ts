import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { beginHeartbeatWakeBroadcast } from "./heartbeat-wake-lifecycle.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";

afterEach(async () => {
  const dispose = setHeartbeatWakeHandler(async () => ({ status: "skipped", reason: "disabled" }));
  await vi.runAllTimersAsync();
  dispose();
  vi.useRealTimers();
});

it.each([false, true])(
  "does not replay completed broadcast work on replacement (new arrival: %s)",
  async (newArrival) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    } as OpenClawConfig;
    let finishOps!: () => void;
    const ops = new Promise<void>((resolve) => {
      finishOps = resolve;
    });
    const firstRun = vi
      .fn<NonNullable<Parameters<typeof startHeartbeatRunner>[0]["runOnce"]>>()
      .mockImplementation(async ({ agentId }) => {
        if (agentId === "ops") {
          await ops;
        }
        return { status: "ran", durationMs: 1 };
      });
    const first = startHeartbeatRunner({ cfg, runOnce: firstRun });
    const done = requestHeartbeatAndWait({ source: "manual", intent: "manual", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(firstRun.mock.calls.map(([opts]) => opts.agentId)).toEqual(["main", "ops"]);
    const laterTasks = [{ jobId: "later", name: "Later", prompt: "New targeted work" }];
    const later = newArrival
      ? requestHeartbeatAndWait({
          source: "manual",
          intent: "manual",
          agentId: "ops",
          tasks: laterTasks,
          coalesceMs: 0,
        })
      : undefined;
    first.stop();
    const secondRun = vi
      .fn<NonNullable<Parameters<typeof startHeartbeatRunner>[0]["runOnce"]>>()
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const second = startHeartbeatRunner({ cfg, runOnce: secondRun });
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(await done).toMatchObject({ status: "ran" });
      expect(secondRun.mock.calls.map(([opts]) => opts.agentId)).toEqual(["ops"]);
      if (later) {
        expect(await later).toMatchObject({ status: "ran" });
        expect(secondRun.mock.calls[0]?.[0].tasks).toEqual(laterTasks);
      }
      finishOps();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(secondRun).toHaveBeenCalledOnce();
      expect(await done).toMatchObject({ status: "ran" });
    } finally {
      finishOps();
      await vi.advanceTimersByTimeAsync(0);
      second.stop();
    }
  },
);

it("settles a fully completed broadcast when replacement wins before the aggregate returns", async () => {
  vi.useFakeTimers();
  const replacement = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
  const dispose = setHeartbeatWakeHandler(async () => {
    const record = beginHeartbeatWakeBroadcast(["main", "ops"]);
    record(0, { status: "ran", durationMs: 1 });
    record(1, { status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(replacement);
    await Promise.resolve();
    return { status: "ran", durationMs: 1 };
  });
  const done = requestHeartbeatAndWait({ source: "manual", intent: "manual", coalesceMs: 0 });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({ status: "ran" });
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
