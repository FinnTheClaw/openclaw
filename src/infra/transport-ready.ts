// Polls channel transports until they are ready for runtime work.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleepWithAbort } from "./backoff.js";

/** Result returned by one transport readiness probe attempt. */
export type TransportReadyResult = {
  ok: boolean;
  error?: string | null;
};

/** Parameters for polling a channel transport until it can accept runtime work. */
export type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<TransportReadyResult>;
};

/**
 * Polls a channel transport readiness probe until it succeeds, times out, or aborts.
 *
 * Used by channel plugins that start external daemons or subscribe to local transports before
 * processing inbound events, with bounded retry logging through the caller's runtime sink.
 */
export async function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void> {
  const started = Date.now();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 0, 0);
  const deadline = started + timeoutMs;
  const logAfterMs = resolveTimerTimeoutMs(params.logAfterMs, timeoutMs, 0);
  const logIntervalMs = resolveTimerTimeoutMs(params.logIntervalMs, 30_000, 1_000);
  const pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 150, 50);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;

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
      timeoutId = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const contenders: Array<Promise<TransportReadyResult | "timeout" | "aborted">> = [
      checkPromise,
      deadlinePromise,
    ];
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
    let outcome: TransportReadyResult | "timeout" | "aborted";
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
    if (res.ok) {
      return;
    }
    lastError = res.error ?? null;

    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      const elapsedMs = now - started;
      params.runtime.error?.(
        danger(`${params.label} not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`),
      );
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

  params.runtime.error?.(
    danger(`${params.label} not ready after ${timeoutMs}ms (${lastError ?? "unknown error"})`),
  );
  throw new Error(`${params.label} not ready (${lastError ?? "unknown error"})`);
}
