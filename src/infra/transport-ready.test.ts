// Covers transport readiness polling.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const transportReadyMocks = vi.hoisted(() => ({
  injectedSleepError: null as Error | null,
}));

type TransportReadyModule = typeof import("./transport-ready.js");
let waitForTransportReady: TransportReadyModule["waitForTransportReady"];

vi.mock("./backoff.js", async (importOriginal) => {
  const { sleepWithAbort } = await importOriginal<typeof import("./backoff.js")>();
  return {
    sleepWithAbort: async (ms: number, signal?: AbortSignal) => {
      if (transportReadyMocks.injectedSleepError) {
        throw transportReadyMocks.injectedSleepError;
      }
      return sleepWithAbort(ms, signal);
    },
  };
});

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function runtimeErrorMessageAt(runtime: ReturnType<typeof createRuntime>, index: number): string {
  const call = runtime.error.mock.calls[index];
  if (!call || typeof call[0] !== "string") {
    throw new Error(`expected runtime error call ${index + 1}`);
  }
  return call[0];
}

function latestRuntimeErrorMessage(runtime: ReturnType<typeof createRuntime>): string {
  return runtimeErrorMessageAt(runtime, runtime.error.mock.calls.length - 1);
}

describe("waitForTransportReady", () => {
  beforeAll(async () => {
    ({ waitForTransportReady } = await import("./transport-ready.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    transportReadyMocks.injectedSleepError = null;
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = createRuntime();
    let attempts = 0;
    const readyPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 220,
      // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { ok: false, error: "not ready" };
      },
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 110,
      logAfterMs: 0,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");
    await vi.advanceTimersByTimeAsync(200);
    await asserted;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("caps oversized timeout values before computing the deadline", async () => {
    vi.setSystemTime(1_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      logAfterMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");

    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await asserted;
    expect(latestRuntimeErrorMessage(runtime)).toContain(
      `not ready after ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  });

  it("returns early when aborted", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady({
      label: "test transport",
      timeoutMs: 200,
      runtime,
      abortSignal: controller.signal,
      check: async () => ({ ok: false, error: "still down" }),
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("stops polling when aborted during the sleep interval", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let attempts = 0;

    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      pollIntervalMs: 50,
      runtime,
      abortSignal: controller.signal,
      check: async () => {
        attempts += 1;
        setTimeout(() => controller.abort(), 10);
        return { ok: false, error: "still down" };
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;

    expect(attempts).toBe(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 120,
      logAfterMs: 0,
      logIntervalMs: 50,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: null }),
    });

    const asserted = expect(waitPromise).rejects.toThrow(
      "test transport not ready (unknown error)",
    );
    await vi.advanceTimersByTimeAsync(200);
    await asserted;

    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMessageAt(runtime, 0)).toContain("unknown error");
    expect(latestRuntimeErrorMessage(runtime)).toContain("not ready after 120ms");
  });

  it.each([
    {
      name: "a never-settling probe times out at zero",
      timeoutMs: 0,
      advanceMs: 1,
      event: "none",
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a never-settling probe times out after one millisecond",
      timeoutMs: 1,
      advanceMs: 2,
      event: "none",
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a never-settling probe times out before the next poll",
      timeoutMs: 40,
      advanceMs: 41,
      event: "none",
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a never-settling probe times out after a longer deadline",
      timeoutMs: 120,
      advanceMs: 121,
      event: "none",
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a hanging retry retains the preceding probe error",
      timeoutMs: 75,
      advanceMs: 76,
      event: "none",
      firstError: "prior down",
      expected: "test transport not ready (prior down)",
      checks: 2,
      errors: 1,
    },
    {
      name: "abort during a hanging probe returns quietly",
      timeoutMs: 200,
      advanceMs: 21,
      event: "abort",
      eventAt: 20,
      expected: "resolved",
      checks: 1,
      errors: 0,
    },
    {
      name: "immediate abort during a hanging probe returns quietly",
      timeoutMs: 200,
      advanceMs: 1,
      event: "abort",
      eventAt: 0,
      expected: "resolved",
      checks: 1,
      errors: 0,
    },
    {
      name: "a late successful probe cannot undo timeout",
      timeoutMs: 50,
      advanceMs: 76,
      event: "resolve",
      eventAt: 75,
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a late rejected probe remains observed after timeout",
      timeoutMs: 50,
      advanceMs: 76,
      event: "reject",
      eventAt: 75,
      expected: "test transport not ready (unknown error)",
      checks: 1,
      errors: 1,
    },
    {
      name: "a probe rejection before the deadline propagates",
      timeoutMs: 200,
      advanceMs: 21,
      event: "reject",
      eventAt: 20,
      expected: "probe exploded",
      checks: 1,
      errors: 0,
    },
  ] as const)("$name", async (scenario) => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let resolveProbe!: (value: { ok: boolean }) => void;
    let rejectProbe!: (reason: Error) => void;
    const probe = new Promise<{ ok: boolean }>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    let checks = 0;
    const result = waitForTransportReady({
      label: "test transport",
      timeoutMs: scenario.timeoutMs,
      pollIntervalMs: 50,
      abortSignal: controller.signal,
      runtime,
      check: () => {
        checks += 1;
        if ("firstError" in scenario && checks === 1) {
          return Promise.resolve({ ok: false, error: scenario.firstError });
        }
        return probe;
      },
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (scenario.event !== "none") {
      setTimeout(() => {
        if (scenario.event === "abort") {
          controller.abort();
        } else if (scenario.event === "resolve") {
          resolveProbe({ ok: true });
        } else {
          rejectProbe(new Error("probe exploded"));
        }
      }, scenario.eventAt);
    }

    await vi.advanceTimersByTimeAsync(scenario.advanceMs);
    expect({
      result: await result,
      checks,
      errors: runtime.error.mock.calls.length,
    }).toEqual({
      result: scenario.expected,
      checks: scenario.checks,
      errors: scenario.errors,
    });
  });

  it("rethrows non-abort sleep failures", async () => {
    const runtime = createRuntime();
    transportReadyMocks.injectedSleepError = new Error("sleep exploded");

    await expect(
      waitForTransportReady({
        label: "test transport",
        timeoutMs: 500,
        pollIntervalMs: 50,
        runtime,
        check: async () => ({ ok: false, error: "still down" }),
      }),
    ).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
