import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createCronServiceWithStateForTest,
  createFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-startup-command-",
  fakeTimers: false,
});

describe("L06-F002 startup command isolation", () => {
  for (const { name, timeoutSeconds, pending } of [
    { name: "a pending zero-timeout command", timeoutSeconds: 0, pending: true },
    { name: "a pending long-timeout command", timeoutSeconds: 3600, pending: true },
    { name: "an immediately completed command", timeoutSeconds: 0, pending: false },
  ]) {
    it(`admits unrelated automatic work beside ${name}`, async ({ signal }) => {
      const store = await withinTest(makeStorePath(), signal);
      const now = Date.parse("2026-11-05T12:00:00.000Z");
      const clock = createGatewaySchedulerClock(now);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const futureAt = now + 5_000;
      const command: CronJob = {
        id: "startup-command",
        name: "controlled startup command",
        agentId: "main",
        enabled: true,
        createdAtMs: now - 120_000,
        updatedAtMs: now - 120_000,
        schedule: { kind: "every", everyMs: 86_400_000, anchorMs: now - 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "command", argv: ["controlled-fixture-only"], timeoutSeconds },
        state: { nextRunAtMs: now - 60_000 },
      };
      const unrelated: CronJob = {
        id: "unrelated-future",
        name: "unrelated automatic job",
        agentId: "main",
        enabled: true,
        createdAtMs: now - 120_000,
        updatedAtMs: now - 120_000,
        schedule: { kind: "at", at: new Date(futureAt).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "controlled marker only" },
        state: { nextRunAtMs: futureAt },
      };
      await withinTest(
        saveCronStore(store.storePath, { version: 1, jobs: [command, unrelated] }),
        signal,
      );
      const entered = createDeferred();
      const release = createDeferred();
      let commandReleased = false;
      let startSettled = false;
      const runCommandJob = vi.fn(async () => {
        entered.resolve();
        if (pending) {
          await release.promise;
        }
        return { status: "ok" as const };
      });
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const finished = createFinishedBarrier();
      const commandFinished = finished.waitForOk(command.id);
      const { cron, state } = createCronServiceWithStateForTest({
        scheduler,
        storePath: store.storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runCommandJob,
        runIsolatedAgentJob,
        onEvent: finished.onEvent,
      });
      let observedStarting = Promise.resolve();
      const wakeErrors: unknown[] = [];
      try {
        const { wake } = await captureCronSchedulerWakeForTest(async () => {
          signal.throwIfAborted();
          observedStarting = cron.start().then(() => {
            startSettled = true;
          });
          // Vitest timeout does not unwind a suspended body by itself. Release
          // this global wake-listener spy before the next case can install one.
          await withinTest(Promise.race([entered.promise, observedStarting]), signal);
        });
        expect(runCommandJob).toHaveBeenCalledOnce();
        if (!pending) {
          await withinTest(commandFinished, signal);
          await withinTest(observedStarting, signal);
        }
        const before = (await withinTest(loadCronStore(store.storePath), signal)).jobs.find(
          (job) => job.id === command.id,
        )?.state;
        // The native SQLite actor now owns the timer. Exercise its registered
        // BroadcastChannel wake, not the retired host GatewayScheduler timer.
        const nextWakeBeforeFuture = (await withinTest(cron.status(), signal)).nextWakeAtMs;
        clock.setTime(futureAt);
        await withinTest(wake(state), signal).catch((error: unknown) => {
          wakeErrors.push(error);
        });
        const automaticObserved = await vi
          .waitUntil(() => runIsolatedAgentJob.mock.calls.length === 1, {
            timeout: 2_000,
            interval: 10,
          })
          .then(
            () => true,
            () => false,
          );
        const after = (await withinTest(loadCronStore(store.storePath), signal)).jobs.find(
          (job) => job.id === command.id,
        )?.state;
        // Startup settlement is diagnostic only: it is not the scheduling oracle.
        const observed = {
          automaticObserved,
          commandCalls: runCommandJob.mock.calls.length,
          unrelatedCalls: runIsolatedAgentJob.mock.calls.length,
          commandStillPending: pending && !commandReleased,
          activeCommandReceipt: Boolean(
            before?.runningReceiptId &&
            before.runningReceiptId === after?.runningReceiptId &&
            typeof after.runningAtMs === "number",
          ),
          commandCompleted: after?.lastRunStatus === "ok",
          wakeErrors,
          startSettled,
          nextWakeBeforeFuture,
        };
        expect(observed).toMatchObject({
          automaticObserved: true,
          commandCalls: 1,
          unrelatedCalls: 1,
          commandStillPending: pending,
          activeCommandReceipt: pending,
          commandCompleted: !pending,
          wakeErrors: [],
        });
      } finally {
        commandReleased = true;
        release.resolve();
        try {
          await observedStarting;
        } finally {
          cron.stop();
          await cron.waitForIdle();
          await scheduler.stop();
          await store.cleanup();
        }
      }
    });
  }
});
