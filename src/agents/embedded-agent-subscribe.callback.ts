import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { EmbeddedAgentEvent } from "./embedded-agent-subscribe.shared-types.js";

/** Shares callback ordering across every model call and subscription in one run. */
export function serializeAgentEventCallback(
  callback: ((event: EmbeddedAgentEvent) => void | Promise<void>) | undefined,
) {
  if (!callback) {
    return undefined;
  }
  let pending: Promise<void> | undefined;
  return (event: EmbeddedAgentEvent) => {
    const result = pending ? pending.then(() => callback(event)) : callback(event);
    if (!isPromiseLike(result)) {
      return undefined;
    }
    const task = Promise.resolve(result);
    const settled = task.then(
      () => {},
      () => {},
    );
    pending = settled;
    void settled.then(() => {
      if (pending === settled) {
        pending = undefined;
      }
    });
    return task;
  };
}

/** Contains callback failures and tracks completion for delivery owners that join it. */
export function runBestEffortCallback(params: {
  callback: () => unknown;
  label: string;
  log: {
    warn(message: string): void;
  };
  pending?: Set<Promise<void>>;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}): void {
  const failed = (error: unknown) => {
    try {
      params.onError?.(error);
    } catch {
      // Completion is best-effort; preserve the original callback failure.
    }
    try {
      params.log.warn(`${params.label} callback failed: ${String(error)}`);
    } catch {
      // Logging must not turn a contained callback failure into a fatal one.
    }
  };
  try {
    const result = params.callback();
    if (isPromiseLike(result)) {
      let task: Promise<void>;
      task = Promise.resolve(result)
        .then(() => params.onSuccess?.())
        .catch(failed)
        .finally(() => {
          params.pending?.delete(task);
        });
      params.pending?.add(task);
    } else {
      params.onSuccess?.();
    }
  } catch (error) {
    failed(error);
  }
}
