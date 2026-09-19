import { AsyncLocalStorage } from "node:async_hooks";
import type {
  HeartbeatRunResult,
  HeartbeatWakeHandler,
  HeartbeatWakeRequest,
} from "./heartbeat-wake-contracts.js";

export type ActiveHeartbeatWakeTarget = {
  generation: number;
  abortController: AbortController;
};

type HeartbeatWakeLifecycle = {
  signal: AbortSignal;
  broadcastResults?: Array<{
    agentId: string;
    result: HeartbeatRunResult;
  }>;
};

const heartbeatWakeAbortSignals = new AsyncLocalStorage<HeartbeatWakeLifecycle>();

/** Propagate lifecycle cancellation into the provider's existing reply abort contract. */
export function getHeartbeatWakeAbortSignal(): AbortSignal | undefined {
  return heartbeatWakeAbortSignals.getStore()?.signal;
}

/** Keep completed broadcast facts on the existing invocation owner before cancellation can win. */
export function beginHeartbeatWakeBroadcast(agentIds: string[]) {
  const lifecycle = heartbeatWakeAbortSignals.getStore();
  const results: NonNullable<HeartbeatWakeLifecycle["broadcastResults"]> = agentIds.map(
    (agentId) => ({
      agentId,
      result: { status: "skipped", reason: "preempted" },
    }),
  );
  if (lifecycle) {
    lifecycle.broadcastResults = results;
  }
  return (index: number, result: HeartbeatRunResult) => {
    results[index]!.result = result;
  };
}

export async function runAbortableHeartbeatWake(
  active: HeartbeatWakeHandler,
  wake: HeartbeatWakeRequest,
  signal: AbortSignal,
): Promise<HeartbeatRunResult> {
  signal.throwIfAborted();
  const lifecycle: HeartbeatWakeLifecycle = { signal };
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<HeartbeatRunResult>((resolve, reject) => {
    abortListener = () => {
      if (lifecycle.broadcastResults) {
        // Snapshot before handing off: a late stale provider must not rewrite
        // completed/unfinished facts already transferred to the replacement.
        const broadcastResults = lifecycle.broadcastResults.map((entry) => ({ ...entry }));
        const completed = broadcastResults.find(({ result }) => result.status === "ran");
        resolve({
          ...(completed?.result ??
            broadcastResults[0]?.result ?? { status: "skipped", reason: "preempted" }),
          broadcastResults,
        });
        return;
      }
      const abortReason = signal.reason;
      reject(
        abortReason instanceof Error ? abortReason : new Error("Heartbeat handler was replaced"),
      );
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    // Keep provider cancellation in the existing reply AbortSignal contract;
    // racing it also retires a non-cooperative stale handler on replacement.
    const running = heartbeatWakeAbortSignals.run(lifecycle, () => active(wake));
    return await Promise.race([running, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export function abortHeartbeatWakeGeneration(
  activeTargets: Iterable<ActiveHeartbeatWakeTarget>,
  generation: number,
): void {
  for (const activeTarget of activeTargets) {
    if (activeTarget.generation === generation) {
      activeTarget.abortController.abort();
    }
  }
}
