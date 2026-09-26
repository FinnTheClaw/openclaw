import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type CallbackLogger = {
  warn(message: string): void;
};

/** Contains callback failures and tracks completion for delivery owners that join it. */
export function runBestEffortCallback(params: {
  callback: () => unknown;
  label: string;
  log: CallbackLogger;
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
