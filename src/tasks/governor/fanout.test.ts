// Proves durable FIFO fan-out, bounded execution, worker fencing, and deterministic fan-in.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorController } from "./controller.js";
import {
  GovernorFanoutStore,
  MAX_GOVERNOR_PHYSICAL_EXECUTIONS,
  type GovernorFanoutJob,
} from "./fanout.js";
import { GovernorSqliteStore } from "./store.js";
import type {
  GovernorPlan,
  GovernorTaskContract,
  GovernorTaskProjection,
  GovernorTaskScope,
} from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-fanout",
  channel: "synthetic",
  accountId: "account-fanout",
  conversationId: "conversation-fanout",
  sessionId: "session-fanout",
  agentId: "agent-fanout",
  workspaceId: "workspace-fanout",
};

const contract: GovernorTaskContract = {
  objective: "Reduce ten independent synthetic findings",
  constraints: ["Use structured synthetic envelopes only"],
  knownFacts: [],
  unknowns: ["worker findings"],
  completionCriteria: [
    { criterionId: "fan-in", description: "All worker findings are reconciled", mandatory: true },
  ],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: [],
    canonicalTargets: [],
  },
};

const plan: GovernorPlan = {
  kind: "dag",
  steps: [
    {
      stepId: "fan-out",
      description: "Run independent synthetic workers",
      criterionIds: ["fan-in"],
      dependsOn: [],
    },
  ],
};

async function withFanout(
  run: (params: {
    controller: GovernorController;
    fanout: GovernorFanoutStore;
    stateDir: string;
    task: GovernorTaskProjection;
  }) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-fanout-" },
    async (state) => {
      const store = new GovernorSqliteStore({ stateDir: state.stateDir });
      const controller = new GovernorController(store, store.capabilities);
      const ingress = controller.ingest({
        sourceMessageId: "fanout-message-1",
        sourceSequence: 1,
        scope,
        mode: "DEEP",
        contract,
        now: 100,
      });
      controller.preparePlan({ taskId: ingress.task.taskId, plan, now: 110 });
      const task = controller.startExecution(ingress.task.taskId, 120);
      try {
        await run({
          controller,
          fanout: new GovernorFanoutStore({ stateDir: state.stateDir }),
          stateDir: state.stateDir,
          task,
        });
      } finally {
        closeOpenClawStateDatabase();
      }
    },
  );
}

function completeJob(params: {
  fanout: GovernorFanoutStore;
  job: GovernorFanoutJob;
  workerId: string;
  now: number;
}) {
  return params.fanout.complete({
    jobId: params.job.jobId,
    taskVersion: params.job.taskVersion,
    leaseEpoch: params.job.leaseEpoch,
    executionGeneration: params.job.executionGeneration,
    claimEpoch: params.job.claimEpoch,
    workerId: params.workerId,
    claims: [{ claim: params.job.jobId }],
    evidence: [{ source: `fixture://${params.job.jobId}` }],
    unresolved: [],
    now: params.now,
  });
}

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("governor durable fan-out and fan-in", () => {
  it("runs an unlimited logical FIFO queue with at most three physical workers", async () => {
    await withFanout(({ fanout, stateDir, task }) => {
      const enqueued = Array.from({ length: 10 }, (_, index) =>
        fanout.enqueue({
          jobId: `job-${String(index + 1).padStart(2, "0")}`,
          task,
          round: 1,
          priority: 10 - index,
          fanoutGroup: "essays",
          expectedOutputTokens: 800,
          expectedDurationMs: 30_000,
          payload: { topic: `topic-${index + 1}` },
          now: 200 + index,
        }),
      );
      expect(enqueued.map((job) => job.queueSequence)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
      expect(
        fanout.enqueue({
          jobId: "job-01",
          task,
          round: 1,
          priority: 10,
          fanoutGroup: "essays",
          expectedOutputTokens: 800,
          expectedDurationMs: 30_000,
          payload: { topic: "topic-1" },
          now: 999,
        }).queueSequence,
      ).toBe(1);
      expect(() =>
        fanout.enqueue({
          jobId: "job-01",
          task,
          round: 1,
          priority: 10,
          fanoutGroup: "essays",
          expectedOutputTokens: 800,
          expectedDurationMs: 30_000,
          payload: { topic: "conflict" },
          now: 1_000,
        }),
      ).toThrow(/Conflicting governor fanout job id/);

      const inFlight: Array<{ job: GovernorFanoutJob; workerId: string }> = [];
      const claimedIds: string[] = [];
      for (let index = 0; index < MAX_GOVERNOR_PHYSICAL_EXECUTIONS; index += 1) {
        const workerId = `worker-${index + 1}`;
        const claim = fanout.claimNext({ workerId, now: 300 + index });
        expect(claim.kind).toBe("claimed");
        if (claim.kind === "claimed") {
          inFlight.push({ job: claim.job, workerId });
          claimedIds.push(claim.job.jobId);
        }
      }
      expect(fanout.claimNext({ workerId: "worker-4", now: 304 })).toEqual({
        kind: "saturated",
      });

      let clock = 400;
      while (inFlight.length > 0) {
        expect(inFlight.length).toBeLessThanOrEqual(MAX_GOVERNOR_PHYSICAL_EXECUTIONS);
        const current = inFlight.shift();
        if (!current) {
          throw new Error("expected an in-flight fanout job");
        }
        expect(completeJob({ fanout, ...current, now: clock }).kind).toBe("completed");
        const workerId = `worker-${claimedIds.length + 1}`;
        const next = fanout.claimNext({ workerId, now: clock + 1 });
        if (next.kind === "claimed") {
          inFlight.push({ job: next.job, workerId });
          claimedIds.push(next.job.jobId);
        } else {
          expect(next.kind).toBe("empty");
        }
        clock += 10;
      }
      expect(claimedIds).toEqual(enqueued.map((job) => job.jobId));
      expect(fanout.listJobs(task.taskId).every((job) => job.state === "completed")).toBe(true);

      const duplicate = completeJob({
        fanout,
        job: { ...enqueued[0]!, claimEpoch: 1 },
        workerId: "worker-1",
        now: clock,
      });
      expect(duplicate.kind).toBe("duplicate");
      const conflict = fanout.complete({
        jobId: "job-01",
        taskVersion: task.taskVersion,
        leaseEpoch: task.leaseEpoch,
        executionGeneration: task.executionGeneration,
        claimEpoch: 1,
        workerId: "worker-1",
        claims: [{ claim: "changed" }],
        evidence: [],
        unresolved: [],
        now: clock + 1,
      });
      expect(conflict.kind).toBe("conflict");

      const reducer = fanout.claimReducer({ task, round: 1, now: clock + 2 });
      expect(reducer.kind).toBe("claimed");
      if (reducer.kind !== "claimed") {
        throw new Error("expected reducer claim");
      }
      expect(reducer.envelopes.map((envelope) => envelope.jobId)).toEqual(claimedIds);
      expect(fanout.claimReducer({ task, round: 1, now: clock + 3 }).kind).toBe("busy");
      expect(
        fanout.completeReducer({
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          planVersion: task.planVersion,
          leaseEpoch: task.leaseEpoch,
          executionGeneration: task.executionGeneration,
          round: 1,
          reducerEpoch: reducer.reducerEpoch,
          envelopeSetDigest: reducer.envelopeSetDigest,
          result: { reconciledJobs: claimedIds },
          now: clock + 4,
        }),
      ).toBe(true);
      expect(fanout.claimReducer({ task, round: 1, now: clock + 5 })).toMatchObject({
        kind: "completed",
        result: { reconciledJobs: claimedIds },
      });

      closeOpenClawStateDatabase();
      const reopened = new GovernorFanoutStore({ stateDir });
      expect(reopened.listJobs(task.taskId)).toHaveLength(10);
      expect(reopened.claimReducer({ task, round: 1, now: clock + 6 }).kind).toBe("completed");
    });
  });

  it("reclaims expired workers and fences late or cancelled results", async () => {
    await withFanout(({ controller, fanout, task }) => {
      for (let index = 1; index <= 2; index += 1) {
        fanout.enqueue({
          jobId: `reclaim-${index}`,
          task,
          round: 2,
          priority: 0,
          fanoutGroup: "reclaim",
          payload: { index },
          now: 200 + index,
        });
      }
      const first = fanout.claimNext({ workerId: "worker-old", now: 300, leaseDurationMs: 10 });
      expect(first.kind).toBe("claimed");
      if (first.kind !== "claimed") {
        throw new Error("expected first worker claim");
      }
      const second = fanout.claimNext({ workerId: "worker-cancel", now: 301 });
      expect(second.kind).toBe("claimed");
      if (second.kind !== "claimed") {
        throw new Error("expected second worker claim");
      }
      expect(fanout.cancelJob(second.job.jobId, 302)).toBe(true);
      expect(fanout.cancelJob(second.job.jobId, 303)).toBe(false);

      const reclaimed = fanout.claimNext({
        workerId: "worker-new",
        now: 311,
        leaseDurationMs: 50,
      });
      expect(reclaimed.kind).toBe("claimed");
      if (reclaimed.kind !== "claimed") {
        throw new Error("expected reclaimed worker claim");
      }
      expect(reclaimed.job).toMatchObject({
        jobId: first.job.jobId,
        claimEpoch: first.job.claimEpoch + 1,
        workerId: "worker-new",
      });
      expect(completeJob({ fanout, job: first.job, workerId: "worker-old", now: 312 }).kind).toBe(
        "stale_worker",
      );
      expect(
        completeJob({ fanout, job: reclaimed.job, workerId: "worker-new", now: 313 }).kind,
      ).toBe("completed");

      fanout.enqueue({
        jobId: "stale-after-correction",
        task,
        round: 3,
        priority: 0,
        fanoutGroup: "stale",
        payload: { safe: true },
        now: 320,
      });
      const runningAfterCorrection = fanout.claimNext({ workerId: "worker-corrected", now: 320 });
      expect(runningAfterCorrection.kind).toBe("claimed");
      if (runningAfterCorrection.kind !== "claimed") {
        throw new Error("expected running stale worker");
      }
      controller.ingest({
        sourceMessageId: "fanout-message-2",
        sourceSequence: 2,
        scope,
        mode: "DEEP",
        contract: { ...contract, objective: "Corrected objective" },
        now: 321,
      });
      expect(fanout.claimNext({ workerId: "worker-late", now: 322 }).kind).toBe("empty");
      expect(
        fanout.listJobs(task.taskId).find((job) => job.jobId === "stale-after-correction"),
      ).toMatchObject({ state: "cancelled" });
      expect(
        completeJob({
          fanout,
          job: runningAfterCorrection.job,
          workerId: "worker-corrected",
          now: 323,
        }).kind,
      ).toBe("stale_worker");
    });
  });

  it("reclaims a crashed reducer and rejects its stale completion", async () => {
    await withFanout(({ fanout, task }) => {
      const queued = fanout.enqueue({
        jobId: "reduce-one",
        task,
        round: 4,
        priority: 0,
        fanoutGroup: "reduce",
        payload: { safe: true },
        now: 200,
      });
      const worker = fanout.claimNext({ workerId: "worker", now: 210 });
      expect(worker.kind).toBe("claimed");
      if (worker.kind !== "claimed") {
        throw new Error("expected worker claim");
      }
      expect(completeJob({ fanout, job: worker.job, workerId: "worker", now: 220 }).kind).toBe(
        "completed",
      );
      expect(queued.jobId).toBe(worker.job.jobId);

      const first = fanout.claimReducer({ task, round: 4, now: 230, leaseDurationMs: 10 });
      expect(first.kind).toBe("claimed");
      if (first.kind !== "claimed") {
        throw new Error("expected first reducer claim");
      }
      const reclaimed = fanout.claimReducer({ task, round: 4, now: 241, leaseDurationMs: 10 });
      expect(reclaimed.kind).toBe("claimed");
      if (reclaimed.kind !== "claimed") {
        throw new Error("expected reclaimed reducer claim");
      }
      expect(reclaimed.reducerEpoch).toBe(first.reducerEpoch + 1);
      const common = {
        taskId: task.taskId,
        taskVersion: task.taskVersion,
        planVersion: task.planVersion,
        leaseEpoch: task.leaseEpoch,
        executionGeneration: task.executionGeneration,
        round: 4,
        envelopeSetDigest: first.envelopeSetDigest,
        result: { complete: true },
      };
      expect(
        fanout.completeReducer({ ...common, reducerEpoch: first.reducerEpoch, now: 242 }),
      ).toBe(false);
      expect(
        fanout.completeReducer({ ...common, reducerEpoch: reclaimed.reducerEpoch, now: 243 }),
      ).toBe(true);
    });
  });
});
