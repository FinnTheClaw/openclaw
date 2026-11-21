import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { sleepWithAbort } from "../infra/backoff.js";
import type { RuntimeEnv } from "../runtime.js";
import { monotonicNow } from "../shared/monotonic-time.js";

export type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<{ ok: boolean; error?: string | null }>;
};

/** Polls until ready, timed out, or aborted, with bounded logging through the runtime sink. */
export async function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void> {
  const started = monotonicNow();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 0, 0);
  const deadline = started + timeoutMs;
  const logAfterMs = resolveTimerTimeoutMs(params.logAfterMs, timeoutMs, 0);
  const logIntervalMs = resolveTimerTimeoutMs(params.logIntervalMs, 30_000, 1_000);
  const pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 150, 50);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;
  const logNotReady = (elapsedMs: number) =>
    params.runtime.error?.(
      theme.error(
        `${params.label} not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`,
      ),
    );

  while (true) {
    if (params.abortSignal?.aborted) {
      return;
    }
    // A probe may never settle. Race it against the remaining deadline and abort signal;
    // Promise.race observes a late probe rejection even after either bound wins.
    const checkPromise = params.check();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const deadlinePromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), Math.max(0, deadline - monotonicNow()));
    });
    const contenders: Array<
      Promise<{ ok: boolean; error?: string | null } | "timeout" | "aborted">
    > = [checkPromise, deadlinePromise];
    if (params.abortSignal) {
      const abortSignal = params.abortSignal;
      contenders.push(
        new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          abortSignal.addEventListener("abort", onAbort, { once: true });
          if (abortSignal.aborted) {
            resolve("aborted");
          }
        }),
      );
    }
    let outcome: { ok: boolean; error?: string | null } | "timeout" | "aborted";
    try {
      outcome = await Promise.race(contenders);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (onAbort) {
        params.abortSignal?.removeEventListener("abort", onAbort);
      }
    }
    if (outcome === "aborted") {
      return;
    }
    if (outcome === "timeout") {
      break;
    }
    const res = outcome;
    if (res.ok || params.abortSignal?.aborted) {
      return;
    }
    lastError = res.error ?? null;

    const now = monotonicNow();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      logNotReady(now - started);
      nextLogAt = now + logIntervalMs;
    }

    try {
      // Abort is cooperative: `sleepWithAbort` may throw on abort, but callers treat abort as
      // a quiet stop rather than a transport failure.
      await sleepWithAbort(pollIntervalMs, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      throw err;
    }
  }

  logNotReady(timeoutMs);
  throw new Error(`${params.label} not ready (${lastError ?? "unknown error"})`);
}

/**
 * Lazy runtime SDK subpath for waiting until an outbound transport is ready.
 */
