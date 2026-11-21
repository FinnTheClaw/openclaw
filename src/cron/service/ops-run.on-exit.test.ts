import { expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { inspectManualRunPreflight } from "./ops-run-preparation.js";
import { runOnExit } from "./ops-run.js";
import { commitCronRunRequests, waitForCronJobRun } from "./run-queue.js";
import type { CronServiceState } from "./state.js";

vi.mock("./locked.js", () => ({
  locked: <T>(_state: unknown, fn: () => Promise<T>) => fn(),
}));
vi.mock("./ops-run-preparation.js", () => ({ inspectManualRunPreflight: vi.fn() }));
vi.mock("./run-queue.js", () => ({
  commitCronRunRequests: vi.fn(),
  drainCronRunQueue: vi.fn(),
  waitForCronJobRun: vi.fn(),
}));
vi.mock("./store.js", () => ({ captureCronServiceMutationSource: vi.fn() }));
vi.mock("./wake.js", () => ({ wake: vi.fn() }));

it("joins a run that becomes busy after the initial on-exit wait", async () => {
  const schedule = { kind: "on-exit", command: "synthetic-exit" } as const;
  const job: CronJob = {
    id: "synthetic-exit",
    name: "Synthetic exit",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Record the observed exit" },
    state: {},
  };
  const state = { lifecycleGeneration: 1, stopped: false, deps: {} } as CronServiceState;
  const joined = Promise.withResolvers<void>();
  const predecessor = Promise.withResolvers<void>();
  vi.mocked(waitForCronJobRun)
    .mockResolvedValue(false)
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(async () => {
      joined.resolve();
      await predecessor.promise;
      return true;
    });
  vi.mocked(inspectManualRunPreflight)
    .mockResolvedValue({ ok: true, ran: false, reason: "not-due" })
    .mockResolvedValueOnce({ ok: true, ran: false, reason: "already-running" })
    .mockResolvedValueOnce({ ok: true, runnable: true, job });
  vi.mocked(commitCronRunRequests).mockResolvedValue([
    {
      job,
      runReceipt: {
        receiptId: "synthetic-receipt",
        jobId: job.id,
        agentId: "main",
        storeKey: "synthetic-store",
        configRevision: "synthetic-revision",
        ownerPid: 1,
        ownerStartTime: null,
        startedAtMs: 2,
      },
      activation: Promise.resolve(),
      completion: Promise.resolve({ ok: true, ran: true }),
    },
  ]);

  const result = runOnExit(state, job.id, {
    schedule,
    signal: new AbortController().signal,
    commitGuard() {},
    onReserved() {},
  });
  try {
    await Promise.race([joined.promise, result]);
    expect(commitCronRunRequests).not.toHaveBeenCalled();
  } finally {
    predecessor.resolve();
  }
  await expect(result).resolves.toEqual({ ok: true, ran: true });
  expect(waitForCronJobRun).toHaveBeenCalledTimes(2);
  expect(inspectManualRunPreflight).toHaveBeenCalledTimes(2);
  expect(commitCronRunRequests).toHaveBeenCalledExactlyOnceWith(
    state,
    [job],
    expect.objectContaining({ mode: "force", source: "manual" }),
  );
});
