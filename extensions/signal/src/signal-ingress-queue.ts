// Signal plugin module owns durable transport ingress before message handling begins.
import { createHash, randomUUID } from "node:crypto";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SignalSseEvent } from "./client-adapter.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_INGRESS_VERSION = 1;
const SIGNAL_INGRESS_MAX_ATTEMPTS = 5;
const SIGNAL_INGRESS_CLAIM_REFRESH_MS = 30_000;
const SIGNAL_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_INGRESS_COMPLETED_MAX_ENTRIES = 5_000;
const SIGNAL_INGRESS_FAILED_MAX_ENTRIES = 1_000;
const SIGNAL_INGRESS_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

// A monitor can reconnect without replacing the gateway process. Track owners in-process so a
// replacement worker can recover a claim from a stopped sibling even though its PID is still live.
// Claims owned by an actually active sibling remain fenced regardless of heartbeat age.
const activeSignalIngressOwners = new Set<string>();

export type SignalIngressPayload = {
  version: typeof SIGNAL_INGRESS_VERSION;
  event: SignalSseEvent;
  receivedAt: number;
};

export type SignalIngressQueue = ChannelIngressQueue<SignalIngressPayload>;

function isSignalIngressPayload(value: SignalIngressPayload): boolean {
  return (
    value.version === SIGNAL_INGRESS_VERSION &&
    typeof value.receivedAt === "number" &&
    Number.isFinite(value.receivedAt) &&
    value.receivedAt > 0 &&
    value.event !== null &&
    typeof value.event === "object"
  );
}

export function createSignalIngressEventId(event: SignalSseEvent): string {
  // signal-cli redelivers the same serialized envelope after reconnects. Hashing the
  // transport bytes gives stable dedupe without conflating separate timestamped messages.
  return createHash("sha256")
    .update(event.event ?? "")
    .update("\0")
    .update(event.data ?? "")
    .digest("hex");
}

export function openSignalIngressQueue(accountId: string): SignalIngressQueue {
  const runtime = getOptionalSignalRuntime();
  if (!runtime) {
    throw new Error("Signal runtime is unavailable for durable ingress");
  }
  return runtime.state.openChannelIngressQueue<SignalIngressPayload>({
    accountId,
    stateDir: runtime.state.resolveStateDir(),
  });
}

function claimOwnerId(): string {
  return `signal-ingress:${process.pid}:${randomUUID()}`;
}

function processPidFromOwnerId(ownerId: string): number | null {
  const match = /^signal-ingress:(\d+):/u.exec(ownerId);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isClaimOwnerAlive(ownerId: string): boolean {
  const pid = processPidFromOwnerId(ownerId);
  if (pid === null) {
    return false;
  }
  if (pid === process.pid) {
    return activeSignalIngressOwners.has(ownerId);
  }
  return isProcessAlive(pid);
}

async function pruneSignalIngressQueue(queue: SignalIngressQueue): Promise<void> {
  await queue.prune({
    completedTtlMs: SIGNAL_INGRESS_COMPLETED_TTL_MS,
    completedMaxEntries: SIGNAL_INGRESS_COMPLETED_MAX_ENTRIES,
    failedTtlMs: SIGNAL_INGRESS_FAILED_TTL_MS,
    failedMaxEntries: SIGNAL_INGRESS_FAILED_MAX_ENTRIES,
  });
}

export type SignalIngressWorker = {
  enqueue(event: SignalSseEvent, receivedAt?: number): Promise<"accepted" | "duplicate">;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
};

export function createSignalIngressWorker(params: {
  queue: SignalIngressQueue;
  handleEvent: (event: SignalSseEvent) => Promise<void>;
  resolveLaneKey?: (event: SignalSseEvent) => string | undefined;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  ownerId?: string;
  claimRefreshMs?: number;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
}): SignalIngressWorker {
  const ownerId = params.ownerId ?? claimOwnerId();
  const claimRefreshMs = Math.max(10, params.claimRefreshMs ?? SIGNAL_INGRESS_CLAIM_REFRESH_MS);
  const maxAttempts = Math.max(1, params.maxAttempts ?? SIGNAL_INGRESS_MAX_ATTEMPTS);
  const retryDelaysMs = params.retryDelaysMs ?? SIGNAL_INGRESS_RETRY_DELAYS_MS;
  const stopController = new AbortController();
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, stopController.signal])
    : stopController.signal;
  let drainTask: Promise<void> | null = null;
  let wakeRequested = false;
  let blockedClaimTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let started = false;
  let lastEnqueuedAt = 0;

  const logStatus = async (prefix: string) => {
    const [pending, claims] = await Promise.all([
      params.queue.listPending({ limit: "all" }),
      params.queue.listClaims(),
    ]);
    params.runtime.log?.(
      `signal durable ingress ${prefix}: working=${claims.length} queued=${pending.length}`,
    );
  };

  const refreshClaimUntilSettled = (claim: ChannelIngressQueueClaim<SignalIngressPayload>) => {
    let done = false;
    const heartbeatController = new AbortController();
    const heartbeatSignal = AbortSignal.any([signal, heartbeatController.signal]);
    const task = (async () => {
      for (;;) {
        if (done || heartbeatSignal.aborted) {
          return;
        }
        try {
          await sleepWithAbort(claimRefreshMs, heartbeatSignal);
        } catch {
          return;
        }
        if (done || heartbeatSignal.aborted) {
          return;
        }
        const refreshed = await params.queue.refreshClaim?.(claim);
        if (refreshed === false) {
          params.runtime.error?.(
            `signal durable ingress lost claim heartbeat for ${claim.id}; processing remains fenced by its claim token`,
          );
          return;
        }
      }
    })();
    return {
      finish: async () => {
        done = true;
        heartbeatController.abort(new Error("Signal ingress claim settled"));
        await task;
      },
    };
  };

  const processClaim = async (claim: ChannelIngressQueueClaim<SignalIngressPayload>) => {
    if (!isSignalIngressPayload(claim.payload)) {
      await params.queue.fail(claim, {
        reason: "invalid-signal-ingress-payload",
        message: "Signal durable ingress payload failed validation.",
      });
      return;
    }
    if (claim.attempts >= maxAttempts) {
      await params.queue.fail(claim, {
        reason: "signal-ingress-retry-limit",
        message: `Signal ingress exhausted ${maxAttempts} attempts before this claim began.`,
      });
      params.runtime.error?.(
        `signal durable ingress ${claim.id} dead-lettered before processing after ${claim.attempts} abandoned or failed attempts`,
      );
      return;
    }
    const heartbeat = refreshClaimUntilSettled(claim);
    try {
      await params.handleEvent(claim.payload.event);
      if (!(await params.queue.complete(claim))) {
        throw new Error(`Signal ingress ${claim.id} lost completion ownership`);
      }
    } catch (err) {
      const message = formatErrorMessage(err);
      if (signal.aborted || stopped) {
        if (
          !(await params.queue.release(claim, {
            lastError: "Signal gateway stopped before processing completed.",
            recordAttempt: false,
          }))
        ) {
          params.runtime.error?.(
            `signal durable ingress ${claim.id} was interrupted and lost release ownership: ${message}`,
          );
        }
        return;
      }
      const nextAttempt = claim.attempts + 1;
      if (nextAttempt >= maxAttempts) {
        await params.queue.fail(claim, {
          reason: "signal-ingress-retry-limit",
          message,
        });
        params.runtime.error?.(
          `signal durable ingress ${claim.id} dead-lettered after ${nextAttempt} attempts: ${message}`,
        );
        return;
      }
      if (!(await params.queue.release(claim, { lastError: message }))) {
        params.runtime.error?.(
          `signal durable ingress ${claim.id} failed and lost release ownership: ${message}`,
        );
        return;
      }
      const delayMs = retryDelaysMs[Math.min(nextAttempt - 1, retryDelaysMs.length - 1)] ?? 0;
      params.runtime.error?.(
        `signal durable ingress ${claim.id} failed; retry ${nextAttempt + 1}/${maxAttempts} in ${delayMs}ms: ${message}`,
      );
      if (delayMs > 0) {
        await sleepWithAbort(delayMs, signal);
      }
    } finally {
      await heartbeat.finish();
    }
  };

  const scheduleBlockedClaimCheck = () => {
    if (blockedClaimTimer || stopped || signal.aborted) {
      return;
    }
    blockedClaimTimer = setTimeout(() => {
      blockedClaimTimer = null;
      wake();
    }, claimRefreshMs);
    blockedClaimTimer.unref?.();
  };

  const recoverAbandonedClaims = async (staleMs: number) => {
    const shouldRecoverOwner = (claimOwner: string) => {
      if (claimOwner === ownerId) {
        return false;
      }
      return !isClaimOwnerAlive(claimOwner);
    };
    return await params.queue.recoverStaleClaims({
      staleMs,
      shouldRecover: (claim) => shouldRecoverOwner(claim.claim.ownerId),
      shouldRecoverCorrupt: (claim) => shouldRecoverOwner(claim.claim.ownerId),
    });
  };

  const drain = async () => {
    for (;;) {
      if (stopped || signal.aborted) {
        return;
      }
      const recovered = await recoverAbandonedClaims(claimRefreshMs * 3);
      if (recovered > 0) {
        params.runtime.log?.(`signal durable ingress recovered ${recovered} abandoned claim(s)`);
      }
      const existingClaims = await params.queue.listClaims();
      if (existingClaims.length > 0) {
        // One account has one processing indicator. A replacement process must wait for
        // the prior lease to expire instead of overtaking it and violating FIFO.
        await logStatus("blocked by existing working claim");
        scheduleBlockedClaimCheck();
        return;
      }
      const claim = await params.queue.claimNext({ ownerId, orderBy: "received" });
      if (!claim) {
        await logStatus("idle");
        return;
      }
      await logStatus(`processing=${claim.id}`);
      await processClaim(claim);
      await pruneSignalIngressQueue(params.queue);
    }
  };

  const wake = () => {
    if (stopped || signal.aborted) {
      return;
    }
    if (drainTask) {
      // A row can commit after an empty drain's final claimNext but before its
      // promise settles. Preserve that wake or the queue stalls until another arrival.
      wakeRequested = true;
      return;
    }
    wakeRequested = false;
    drainTask = drain()
      .catch((err: unknown) => {
        params.runtime.error?.(`signal durable ingress drain failed: ${formatErrorMessage(err)}`);
      })
      .finally(() => {
        drainTask = null;
        if (wakeRequested) {
          wake();
        }
      });
  };

  const recoverDeadProcessClaims = async () => {
    const recovered = await recoverAbandonedClaims(0);
    if (recovered > 0) {
      params.runtime.log?.(`signal durable ingress recovered ${recovered} abandoned claim(s)`);
    }
  };

  return {
    enqueue: async (event, receivedAt = Date.now()) => {
      // Signal can deliver a burst inside one millisecond. SQLite's secondary event-id ordering
      // would then sort by hash rather than arrival order, so assign a monotonic receipt sequence
      // before the first async boundary.
      const orderedReceivedAt = Math.max(Math.floor(receivedAt), lastEnqueuedAt + 1);
      lastEnqueuedAt = orderedReceivedAt;
      const result = await params.queue.enqueue(
        createSignalIngressEventId(event),
        { version: SIGNAL_INGRESS_VERSION, event, receivedAt: orderedReceivedAt },
        { receivedAt: orderedReceivedAt, laneKey: params.resolveLaneKey?.(event) },
      );
      await pruneSignalIngressQueue(params.queue);
      wake();
      return result.kind === "accepted" ? "accepted" : "duplicate";
    },
    start: async () => {
      if (started) {
        return;
      }
      if (stopped) {
        throw new Error("Cannot restart a stopped Signal durable ingress worker");
      }
      started = true;
      activeSignalIngressOwners.add(ownerId);
      try {
        await pruneSignalIngressQueue(params.queue);
        await recoverDeadProcessClaims();
        await logStatus("started");
        wake();
      } catch (err) {
        activeSignalIngressOwners.delete(ownerId);
        started = false;
        throw err;
      }
    },
    stop: async () => {
      stopped = true;
      activeSignalIngressOwners.delete(ownerId);
      if (blockedClaimTimer) {
        clearTimeout(blockedClaimTimer);
        blockedClaimTimer = null;
      }
      stopController.abort(new Error("Signal durable ingress stopped"));
      await drainTask;
    },
    waitForIdle: async () => {
      await drainTask;
    },
  };
}
