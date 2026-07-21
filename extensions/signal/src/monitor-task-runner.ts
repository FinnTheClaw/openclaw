// Signal monitor task tracking keeps transport persistence and legacy handlers drainable.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

export function createSignalMonitorTaskRunner(runtime: RuntimeEnv) {
  const inFlight = new Set<Promise<void>>();
  const track = (task: Promise<unknown>): void => {
    const trackedTask: Promise<void> = task
      .then(() => undefined)
      .catch((err: unknown) => runtime.error?.(`signal monitor task failed: ${String(err)}`))
      .finally(() => inFlight.delete(trackedTask));
    inFlight.add(trackedTask);
  };
  return {
    runTask(task: () => Promise<void>): void {
      track(Promise.resolve().then(task));
    },
    track,
    async waitForIdle(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
    },
  };
}
