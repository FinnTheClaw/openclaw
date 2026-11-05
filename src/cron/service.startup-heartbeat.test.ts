import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  requestHeartbeatAndWait as requestQueuedHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../infra/heartbeat-wake.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { getSuspensionVisibleCronTaskRunCount } from "./service/active-run-cancellation.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-startup-heartbeat-",
  fakeTimers: false,
});

describe("heartbeat startup catch-up", () => {
  it("records a handler-unavailable non-outcome for an early heartbeat run", async () => {
    const store = await makeStorePath();
    setHeartbeatWakeHandler(null);
    const entered = createDeferred<{ result: Promise<HeartbeatRunResult> }>();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(),
      storePath: store.storePath,
      logger,
      resolveHeartbeatTimeoutMs: () => undefined,
      requestHeartbeatAndWait: (wake, lifecycle) => {
        const result = requestQueuedHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle);
        entered.resolve({ result });
        return result;
      },
    });
    await cron.start();
    const added = await cron.add(
      {
        declarationKey: "heartbeat:main",
        name: "early heartbeat",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "heartbeat" },
      },
      { enabledExplicit: true, systemOwned: true },
    );
    const job = "job" in added ? added.job : added;
    const running = cron.run(job.id, "force");
    try {
      const { result } = await entered.promise;
      expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({
        status: "skipped",
        reason: "handler-unavailable",
      });
      await running;
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: "heartbeat skipped: handler-unavailable",
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
    } finally {
      await running;
      cron.stop();
      setHeartbeatWakeHandler(null);
      await store.cleanup();
    }
  });

  it.each([
    { name: "monitor", declarationKey: "heartbeat:main", payload: { kind: "heartbeat" } },
    {
      name: "task",
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      payload: { kind: "systemEvent", text: "Check the inbox" },
    },
    { name: "immediate event", payload: { kind: "systemEvent", text: "Deliver the reminder" } },
  ] as const)("defers an overdue $name without awaiting its heartbeat", async (testCase) => {
    const store = await makeStorePath();
    const scheduler = createTestGatewayScheduler();
    const now = scheduler.now();
    const job: CronJob = {
      id: "overdue-heartbeat",
      name: testCase.name,
      ...("declarationKey" in testCase ? { declarationKey: testCase.declarationKey } : {}),
      agentId: "main",
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: "main",
      wakeMode: testCase.name === "immediate event" ? "now" : "next-heartbeat",
      payload: testCase.payload,
      state: { nextRunAtMs: now - 60_000 },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const entered = createDeferred<"heartbeat">();
    const release = createDeferred<HeartbeatRunResult>();
    const requestHeartbeatAndWait = vi.fn(async () => {
      entered.resolve("heartbeat");
      return await release.promise;
    });
    const cron = new CronService({
      scheduler,
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      requestHeartbeatAndWait,
      resolveHeartbeatTimeoutMs: () => undefined,
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const starting = cron.start();
    try {
      expect(await Promise.race([starting.then(() => "started"), entered.promise])).toBe("started");
      expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: now + 120_000, startupCatchupAtMs: now + 120_000 },
      });
    } finally {
      release.resolve({ status: "skipped", reason: "disabled" });
      await starting;
      cron.stop();
      await store.cleanup();
    }
  });
});

describe("L06-F002 startup command isolation", () => {
  it.each([
    { name: "a pending zero-timeout command", timeoutSeconds: 0, pending: true },
    { name: "a pending long-timeout command", timeoutSeconds: 3600, pending: true },
    { name: "an immediately completed command", timeoutSeconds: 0, pending: false },
  ])("admits unrelated automatic work beside $name", async ({ timeoutSeconds, pending }) => {
    const store = await makeStorePath();
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
    await saveCronStore(store.storePath, { version: 1, jobs: [command, unrelated] });
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
    const cron = new CronService({
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
    const starting = cron.start();
    const observedStarting = starting.then(() => {
      startSettled = true;
    });
    const wakes: Promise<void>[] = [];
    const wakeErrors: unknown[] = [];
    try {
      await Promise.race([entered.promise, observedStarting]);
      if (runCommandJob.mock.calls.length === 0) {
        const startupWake = clock.wake();
        if (startupWake) {
          wakes.push(
            Promise.resolve(startupWake).catch((error: unknown) => {
              wakeErrors.push(error);
            }),
          );
        }
        await vi.waitUntil(() => runCommandJob.mock.calls.length === 1, {
          timeout: 2_000,
          interval: 10,
        });
      }
      if (!pending) {
        await commandFinished;
        await vi.waitUntil(() => clock.armedAtMs !== null, {
          timeout: 2_000,
          interval: 10,
        });
      }
      const before = (await loadCronStore(store.storePath)).jobs.find(
        (job) => job.id === command.id,
      )?.state;
      const armedBeforeFuture = clock.armedAtMs;
      const wake = clock.advanceTo(futureAt);
      if (wake) {
        wakes.push(
          Promise.resolve(wake).catch((error: unknown) => {
            wakeErrors.push(error);
          }),
        );
      }
      let automaticObserved = runIsolatedAgentJob.mock.calls.length === 1;
      if (armedBeforeFuture !== null) {
        automaticObserved = await vi
          .waitUntil(() => runIsolatedAgentJob.mock.calls.length === 1, {
            timeout: 2_000,
            interval: 10,
          })
          .then(
            () => true,
            () => false,
          );
      }
      const after = (await loadCronStore(store.storePath)).jobs.find(
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
        armedBeforeFuture,
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
      await observedStarting;
      await Promise.all(wakes);
      cron.stop();
      await store.cleanup();
    }
  });
});
