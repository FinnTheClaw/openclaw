import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { waitForTransportReady } from "../plugin-sdk/transport-ready-runtime.js";
import { sleepWithAbort } from "./backoff.js";

vi.mock("./backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backoff.js")>();
  return { ...actual, sleepWithAbort: vi.fn(actual.sleepWithAbort) };
});

describe("waitForTransportReady", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  function wait(options: Partial<Parameters<typeof waitForTransportReady>[0]> = {}) {
    return waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
      ...options,
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    runtime = createTestRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    let attempts = 0;
    const readyPromise = wait({
      timeoutMs: 220,
      logAfterMs: 1,
      logIntervalMs: 1_000,
      check: async () => (++attempts > 2 ? { ok: true } : { ok: false, error: "not ready" }),
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("caps oversized timeout values before computing the deadline", async () => {
    vi.setSystemTime(1_000);
    const waitPromise = wait({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      logAfterMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");

    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    await asserted;
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      `not ready after ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  });

  it.each(["before", "probe", "sleep"] as const)(
    "stops quietly when aborted during %s",
    async (phase) => {
      vi.setSystemTime(0);
      const controller = new AbortController();
      const probe = createDeferred<{ ok: boolean; error: string }>();
      const check = vi.fn(async () => {
        if (phase === "probe") {
          return probe.promise;
        }
        setTimeout(() => controller.abort(), 10);
        return { ok: false, error: "still down" };
      });
      if (phase === "before") {
        controller.abort();
      }
      const waiting = wait({
        timeoutMs: 100,
        logAfterMs: phase === "probe" ? 0 : 100,
        abortSignal: controller.signal,
        check,
      });
      const attempts = phase === "before" ? 0 : 1;
      if (phase === "probe") {
        controller.abort();
        vi.setSystemTime(150);
        probe.resolve({ ok: false, error: "still down" });
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      await expect(waiting).resolves.toBeUndefined();
      expect(check).toHaveBeenCalledTimes(attempts);
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const waitPromise = wait({
      timeoutMs: 120,
      logAfterMs: 0,
      logIntervalMs: 50,
      check: async () => ({ ok: false, error: null }),
    });

    const asserted = expect(waitPromise).rejects.toThrow(
      "test transport not ready (unknown error)",
    );
    await vi.advanceTimersByTimeAsync(200);
    await asserted;

    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("unknown error");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("not ready after 120ms");
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
    const runtime = createTestRuntime();
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
    vi.mocked(sleepWithAbort).mockRejectedValueOnce(new Error("sleep exploded"));

    await expect(wait()).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
