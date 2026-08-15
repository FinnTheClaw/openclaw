import type { FunctionalFinnMemoryProjectionState } from "./memory-materializer.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

type IntervalScheduler = {
  set: (callback: () => void, intervalMs: number) => unknown;
  clear: (handle: unknown) => void;
};

type TimeoutScheduler = {
  set: (callback: () => void, timeoutMs: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultIntervalScheduler: IntervalScheduler = {
  set(callback, intervalMs) {
    const handle = setInterval(callback, intervalMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

const defaultTimeoutScheduler: TimeoutScheduler = {
  set(callback, timeoutMs) {
    const handle = setTimeout(callback, timeoutMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export type FunctionalFinnProjectionReconciler = {
  reconcileAgent: (
    agentId: string,
    options?: { force?: boolean },
  ) => Promise<FunctionalFinnMemoryProjectionState>;
};

export class FunctionalFinnMemoryProjectionService {
  private timer: unknown;
  private tail: Promise<void> = Promise.resolve();
  private state: "idle" | "starting" | "running" | "closing" | "closed" | "failed" = "idle";
  private terminalError: unknown;
  private closePromise: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly projector: FunctionalFinnProjectionReconciler,
    private readonly agentIds: readonly string[],
    private readonly onError: (agentId: string, error: unknown) => void,
    private readonly intervalScheduler: IntervalScheduler = defaultIntervalScheduler,
    private readonly intervalMs = RECONCILE_INTERVAL_MS,
    private readonly closeTimeoutMs = CLOSE_TIMEOUT_MS,
    private readonly timeoutScheduler: TimeoutScheduler = defaultTimeoutScheduler,
  ) {}

  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    if (this.state !== "idle") {
      throw this.lifecycleError("start");
    }
    this.state = "starting";
    try {
      await this.enqueue(this.agentIds, true);
      if (this.state !== "starting") {
        throw this.lifecycleError("finish startup");
      }
      this.state = "running";
      this.timer = this.intervalScheduler.set(() => {
        void this.enqueue(this.agentIds, false).catch(() => undefined);
      }, this.intervalMs);
    } catch (error) {
      if (this.state === "starting") {
        this.terminalError = error;
        this.state = "failed";
      }
      throw error;
    }
  }

  reconcileAgent(agentId: string): Promise<FunctionalFinnMemoryProjectionState> {
    if (this.state !== "running") {
      return Promise.reject(this.lifecycleError("reconcile"));
    }
    return this.track(this.projector.reconcileAgent(agentId));
  }

  runExpiryReconciliation(): Promise<void> {
    if (this.state !== "running") {
      return Promise.reject(this.lifecycleError("reconcile expiry"));
    }
    return this.enqueue(this.agentIds, false);
  }

  stop(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.timer !== undefined) {
      this.intervalScheduler.clear(this.timer);
      this.timer = undefined;
    }
    if (this.state === "closed") {
      return;
    }
    const priorFailure = this.state === "failed" ? this.terminalError : undefined;
    this.state = "closing";
    let timeoutHandle: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.timeoutScheduler.set(
        () => reject(new Error("Functional Finn memory projection close timed out")),
        this.closeTimeoutMs,
      );
    });
    try {
      const drain = Promise.allSettled([this.tail, ...this.active]).then((results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason)
          .filter((error) => error !== priorFailure);
        if (failures.length > 0) {
          throw new AggregateError(
            priorFailure ? [priorFailure, ...failures] : failures,
            "Functional Finn memory projection drain failed",
          );
        }
      });
      await Promise.race([drain, timeout]);
      if (priorFailure) {
        throw priorFailure instanceof Error
          ? priorFailure
          : new Error("Functional Finn memory projection failed", { cause: priorFailure });
      }
      this.state = "closed";
    } catch (error) {
      this.terminalError = error;
      this.state = "failed";
      throw error;
    } finally {
      if (timeoutHandle !== undefined) {
        this.timeoutScheduler.clear(timeoutHandle);
      }
    }
  }

  private enqueue(agentIds: readonly string[], force: boolean): Promise<void> {
    if (this.state !== "starting" && this.state !== "running") {
      return Promise.reject(this.lifecycleError("schedule reconciliation"));
    }
    const run = async () => {
      const failures: unknown[] = [];
      for (const agentId of agentIds) {
        try {
          await this.projector.reconcileAgent(agentId, { force });
        } catch (error) {
          this.onError(agentId, error);
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Functional Finn memory projection failed");
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next;
    return next;
  }

  private lifecycleError(operation: string): Error {
    const suffix = this.terminalError instanceof Error ? `: ${this.terminalError.message}` : "";
    return new Error(
      `Functional Finn memory projection cannot ${operation} while ${this.state}${suffix}`,
    );
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    return promise.finally(() => this.active.delete(promise));
  }
}
