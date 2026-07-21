// Throttled, deterministic Signal progress messages for tool-heavy turns.

const FIRST_UPDATE_DELAY_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 45_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type SignalProgressEmitter = {
  noteToolStart: (name?: string) => void;
  noteCompaction: () => void;
  stop: () => void;
};

function friendlyToolName(raw?: string): string {
  const normalized = String(raw || "tool")
    .replace(/^mcp__[^_]+__/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || "tool";
}

export function createSignalProgressEmitter(params: {
  enabled: boolean;
  onProgress: (text: string) => Promise<void> | void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  firstUpdateDelayMs?: number;
  heartbeatIntervalMs?: number;
}): SignalProgressEmitter {
  const now = params.now ?? Date.now;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const firstDelay = params.firstUpdateDelayMs ?? FIRST_UPDATE_DELAY_MS;
  const heartbeatDelay = params.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let timer: TimerHandle | undefined;
  let stopped = false;
  let startedAt = 0;
  let toolCount = 0;
  let currentActivity = "working";
  let updateCount = 0;
  let inFlight = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (stopped || !params.enabled) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = undefined;
      void emit();
    }, Math.max(1, delayMs));
  };

  async function emit() {
    if (stopped || !params.enabled || inFlight || toolCount === 0) {
      return;
    }
    inFlight = true;
    updateCount += 1;
    const elapsedSeconds = Math.max(1, Math.round((now() - startedAt) / 1_000));
    const prefix = updateCount === 1 ? "Working" : "Still working";
    try {
      await params.onProgress(
        `${prefix}: ${currentActivity} (step ${toolCount}, ${elapsedSeconds}s elapsed).`,
      );
    } catch {
      // Progress delivery is best-effort and must never fail the actual turn.
    } finally {
      inFlight = false;
      if (!stopped) {
        schedule(heartbeatDelay);
      }
    }
  }

  return {
    noteToolStart(name?: string) {
      if (stopped || !params.enabled) {
        return;
      }
      if (!startedAt) {
        startedAt = now();
        schedule(firstDelay);
      }
      toolCount += 1;
      currentActivity = `running ${friendlyToolName(name)}`;
    },
    noteCompaction() {
      if (stopped || !params.enabled) {
        return;
      }
      if (!startedAt) {
        startedAt = now();
        schedule(firstDelay);
      }
      currentActivity = "organizing the working context";
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
