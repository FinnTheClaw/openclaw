import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { fanoutTerminationReceiptPayload } from "./fanout-physical.js";
import {
  memoryScopeA,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor external child lifecycle", () => {
  it("requires host receipts and blocks parent completion until durable aggregation", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const task = store.loadTask(taskId);
      if (!task) {
        throw new Error("missing child parent task");
      }
      expect(() =>
        store.children.register({ task, receiptId: "ghr_invented" as never, now: 40 }),
      ).toThrow(/receipt/);
      const rawChildId = "private-child-fixture";
      const registrationPayload = {
        kind: "governor_external_child_registration",
        childRunId: rawChildId,
        round: 7,
        priority: 1,
        request: { objective: "inspect fixture" },
      } as const;
      const registrationReceipt = broker.capabilities.submitObservedReceipt({
        scopeKey: task.scopeKey,
        taskId: task.taskId,
        taskVersion: task.taskVersion,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        sourceKind: "structured_external",
        sourceIdentity: rawChildId,
        payload: registrationPayload,
        observedAt: 40,
      });
      const child = store.children.register({ task, receiptId: registrationReceipt, now: 40 });
      expect(store.children.register({ task, receiptId: registrationReceipt, now: 40 })).toEqual(
        child,
      );
      const claim = store.fanout.claimNext({ workerId: "child-worker", now: 41 });
      if (claim.kind !== "claimed") {
        throw new Error(`expected child claim, got ${claim.kind}`);
      }
      const completion = {
        jobId: child.jobId,
        taskVersion: child.taskVersion,
        leaseEpoch: child.leaseEpoch,
        executionGeneration: child.executionGeneration,
        claimEpoch: claim.job.claimEpoch,
        workerId: "child-worker",
        claims: [{ status: "done" }],
        evidence: [{ fixture: true }],
        unresolved: [],
        now: 42,
      } as const;
      expect(store.fanout.complete(completion)).toEqual({ kind: "stale_worker" });
      const terminalPayload = {
        kind: "governor_external_child_terminal",
        childHandle: child.jobId,
        outcome: "completed",
        claims: [...completion.claims],
        evidence: [...completion.evidence],
        unresolved: [...completion.unresolved],
      };
      const terminalReceipt = broker.capabilities.submitObservedReceipt({
        scopeKey: task.scopeKey,
        taskId: task.taskId,
        taskVersion: task.taskVersion,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        sourceKind: "structured_external",
        sourceIdentity: rawChildId,
        payload: terminalPayload,
        observedAt: 42,
      });
      expect(
        store.children.complete({ ...completion, terminalReceiptId: terminalReceipt }),
      ).toMatchObject({ kind: "completed" });
      expect(store.listUnfinishedFanoutJobIds(task)).toEqual(["fanin:7"]);
      const reducer = store.fanout.claimReducer({ task, round: 7, now: 43 });
      if (reducer.kind !== "claimed") {
        throw new Error(`expected child reducer claim, got ${reducer.kind}`);
      }
      expect(
        store.fanout.completeReducer({
          taskId,
          planVersion: task.planVersion,
          round: 7,
          taskVersion: task.taskVersion,
          leaseEpoch: task.leaseEpoch,
          executionGeneration: task.executionGeneration,
          reducerEpoch: reducer.reducerEpoch,
          envelopeSetDigest: reducer.envelopeSetDigest,
          result: { aggregate: "accepted" },
          now: 44,
        }),
      ).toBe(true);
      expect(store.listUnfinishedFanoutJobIds(task)).toEqual([]);
      closeOpenClawStateDatabase();
      const restarted = new (await import("./store.js")).GovernorSqliteStore({ stateDir });
      expect(restarted.listUnfinishedFanoutJobIds(task)).toEqual([]);
      const { db } = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      expect(
        JSON.stringify(db.prepare("SELECT payload_json FROM governor_fanout_jobs").all()),
      ).not.toContain(rawChildId);
    });
  });

  it("keeps an unknown child pending until authenticated termination", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA, 9);
      const task = store.loadTask(taskId)!;
      const payload = {
        kind: "governor_external_child_registration",
        childRunId: "unknown-child-fixture",
        round: 8,
        priority: 1,
        request: { objective: "unknown fixture" },
      } as const;
      const receiptId = broker.capabilities.submitObservedReceipt({
        scopeKey: task.scopeKey,
        taskId,
        taskVersion: task.taskVersion,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        sourceKind: "structured_external",
        sourceIdentity: "unknown-child-fixture",
        payload,
        observedAt: 100,
      });
      const child = store.children.register({ task, receiptId, now: 100 });
      const claim = store.fanout.claimNext({ workerId: "unknown-worker", now: 101 });
      expect(claim.kind).toBe("claimed");
      expect(store.children.markUnknown(child.jobId, 102)).toBe(true);
      expect(store.listUnfinishedFanoutJobIds(task)).toEqual([child.jobId]);
      const running = store.children.list(taskId)[0]!;
      const terminationPayload = fanoutTerminationReceiptPayload(running, "crashed");
      const terminationReceipt = broker.capabilities.submitObservedReceipt({
        scopeKey: task.scopeKey,
        taskId,
        taskVersion: running.taskVersion,
        objectiveRevision: running.objectiveRevision,
        planVersion: running.planVersion,
        sourceKind: "structured_external",
        sourceIdentity: "child-supervisor",
        payload: terminationPayload,
        observedAt: 103,
      });
      expect(
        store.fanout.acknowledgeTermination({
          jobId: child.jobId,
          receiptId: terminationReceipt,
          outcome: "crashed",
          now: 103,
        }),
      ).toBe(true);
      expect(store.listUnfinishedFanoutJobIds(task)).toEqual([]);
    });
  });
});
