import { describe, expect, it, vi } from "vitest";
import { createSignalProgressEmitter } from "./progress-emitter.js";

describe("Signal progress emitter", () => {
  it("emits a delayed first update and throttled heartbeat", async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const emitter = createSignalProgressEmitter({
      enabled: true,
      onProgress,
      now: () => Date.now(),
      firstUpdateDelayMs: 4_000,
      heartbeatIntervalMs: 45_000,
    });

    emitter.noteToolStart("shell_command");
    emitter.noteToolStart("view_file");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(onProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onProgress).toHaveBeenCalledWith(
      "Working: running view file (step 2, 4s elapsed).",
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onProgress).toHaveBeenLastCalledWith(
      "Still working: running view file (step 2, 49s elapsed).",
    );
    emitter.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onProgress).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not let delivery failures stop future heartbeats", async () => {
    vi.useFakeTimers();
    const onProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error("signal unavailable"))
      .mockResolvedValue(undefined);
    const emitter = createSignalProgressEmitter({
      enabled: true,
      onProgress,
      firstUpdateDelayMs: 1,
      heartbeatIntervalMs: 10,
    });

    emitter.noteToolStart("exec");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).toHaveBeenCalledTimes(2);
    emitter.stop();
    vi.useRealTimers();
  });
});
