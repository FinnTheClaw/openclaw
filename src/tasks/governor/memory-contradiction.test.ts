// Proves scoped supersession, one remediation, restart safety, and verified repair closure.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { GovernorController } from "./controller.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  correctMemoryTestTask,
  memoryRepairAction,
  memoryScopeA,
  memoryScopeB,
  memoryTestRegistry,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { createGovernorTestStore } from "./test-broker.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor memory contradiction retirement", () => {
  it("atomically replaces a stale SSH path and reuses one remediation across restart", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-ssh-old",
        factKey: "ssh.path",
        path: "/legacy/key",
        observedAt: 100,
        sourceKind: "structured_external",
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-ssh-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/verified/key" },
        observedAt: 200,
      });
      const fence = controller.captureExecutionFence(taskId);
      const [first, duplicate] = await Promise.all([
        Promise.resolve().then(() =>
          controller.memoryRemediation.resolve({
            taskId,
            evidenceId: "evidence-ssh-current",
            staleMemoryId: "memory-ssh-old",
            contradictionClass: "stale canonical source",
            executionFence: fence,
            progressVector: { fact: "ssh.path", phase: "repair" },
            repairAction: memoryRepairAction(),
            freshnessExpiresAt: 500,
            now: 201,
          }),
        ),
        Promise.resolve().then(() =>
          controller.memoryRemediation.resolve({
            taskId,
            evidenceId: "evidence-ssh-current",
            staleMemoryId: "memory-ssh-old",
            contradictionClass: "stale canonical source",
            executionFence: fence,
            progressVector: { fact: "ssh.path", phase: "repair" },
            repairAction: memoryRepairAction(),
            freshnessExpiresAt: 500,
            now: 202,
          }),
        ),
      ]);
      expect([first.resolution.kind, duplicate.resolution.kind].toSorted()).toEqual([
        "duplicate",
        "retired",
      ]);
      const active = Array.from({ length: 100 }, () =>
        store.memory.activeReplacement({ scope: memoryScopeA, factKey: "ssh.path", now: 250 }),
      );
      expect(active.map((memory) => memory?.content)).toEqual(
        Array.from({ length: 100 }, () => ({ path: "/verified/key" })),
      );
      const audit = store.memory.retrieveAudit({ scope: memoryScopeA });
      expect(audit).toHaveLength(2);
      expect(audit.find((memory) => memory.memoryId === "memory-ssh-old")).toMatchObject({
        status: "superseded",
        replacementMemoryId: active[0]?.memoryId,
      });
      expect(active[0]).toMatchObject({ supersedesId: "memory-ssh-old", status: "verified" });
      const remediation = store.memory.listRemediations(memoryScopeA);
      expect(remediation).toHaveLength(1);
      expect(remediation[0]).toMatchObject({ investigationCount: 1, status: "queued" });
      expect(store.actionIntents.listPendingIds(taskId, 1)).toHaveLength(1);
      const fingerprint = remediation[0]?.contradictionFingerprint;
      if (!fingerprint) {
        throw new Error("expected contradiction fingerprint");
      }
      expect(
        store.memory.reinvestigationDecision({
          fingerprint,
          scope: memoryScopeA,
          taskId,
          evidenceId: "evidence-ssh-current",
          now: 250,
        }),
      ).toEqual({ reopen: false, reason: "reuse_resolved" });
      expect(
        store.memory.reinvestigationDecision({
          fingerprint,
          scope: memoryScopeA,
          operatorRequested: true,
          now: 250,
        }),
      ).toEqual({ reopen: true, reason: "operator_requested" });
      expect(
        store.memory.reinvestigationDecision({
          fingerprint,
          scope: memoryScopeB,
          now: 250,
        }),
      ).toEqual({ reopen: true, reason: "different_scope" });
      expect(
        store.memory.reinvestigationDecision({
          fingerprint,
          scope: memoryScopeA,
          now: 501,
        }),
      ).toEqual({ reopen: true, reason: "replacement_freshness_expired" });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-ssh-materially-new",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/verified/key-v2" },
        observedAt: 300,
      });
      expect(
        store.memory.reinvestigationDecision({
          fingerprint,
          scope: memoryScopeA,
          taskId,
          evidenceId: "evidence-ssh-materially-new",
          now: 301,
        }),
      ).toEqual({ reopen: true, reason: "materially_new_evidence" });

      closeOpenClawStateDatabase();
      const restartedCapabilities = memoryTestRegistry();
      const restarted = createGovernorTestStore({
        stateDir,
        capabilities: restartedCapabilities,
      });
      const restartedController = new GovernorController(restarted.store, restartedCapabilities);
      expect(
        restarted.store.memory.activeReplacement({
          scope: memoryScopeA,
          factKey: "ssh.path",
          now: 251,
        }),
      ).toMatchObject({ content: { path: "/verified/key" } });
      expect(restarted.store.memory.listRemediations(memoryScopeA)).toHaveLength(1);
      const replay = restartedController.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-ssh-current",
        staleMemoryId: "memory-ssh-old",
        contradictionClass: "stale canonical source",
        executionFence: restartedController.captureExecutionFence(taskId),
        progressVector: { fact: "ssh.path", phase: "repair" },
        repairAction: memoryRepairAction(),
        now: 252,
      });
      expect(replay.resolution.kind).toBe("duplicate");
      expect(restarted.store.memory.listRemediations(memoryScopeA)[0]?.investigationCount).toBe(1);
      expect(restarted.store.actionIntents.listPendingIds(taskId, 1)).toHaveLength(1);
    });
  });

  it("rejects older evidence and does not apply another scope's evidence", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskA = startMemoryTestTask(controller, memoryScopeA, 1);
      const taskB = startMemoryTestTask(controller, memoryScopeB, 2);
      seedMemoryFact({
        store,
        broker,
        taskId: taskA,
        scope: memoryScopeA,
        memoryId: "memory-a-old",
        factKey: "ssh.path",
        path: "/a/old",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId: taskB,
        evidenceId: "evidence-scope-b",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/b/current" },
        observedAt: 300,
      });
      expect(
        controller.memoryRemediation.resolve({
          taskId: taskB,
          evidenceId: "evidence-scope-b",
          staleMemoryId: "memory-a-old",
          contradictionClass: "stale canonical source",
          executionFence: controller.captureExecutionFence(taskB),
          progressVector: { scope: "b" },
          now: 301,
        }).resolution,
      ).toMatchObject({ kind: "rejected", reason: "scope_mismatch" });
      persistMemoryEvidence({
        store,
        broker,
        taskId: taskA,
        evidenceId: "evidence-a-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/a/current" },
        observedAt: 250,
      });
      const replacement = controller.memoryRemediation.resolve({
        taskId: taskA,
        evidenceId: "evidence-a-current",
        staleMemoryId: "memory-a-old",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskA),
        progressVector: { scope: "a" },
        now: 251,
      }).resolution;
      if (replacement.kind !== "retired") {
        throw new Error("expected same-scope replacement");
      }
      persistMemoryEvidence({
        store,
        broker,
        taskId: taskA,
        evidenceId: "evidence-a-older",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/a/replayed" },
        observedAt: 200,
      });
      expect(
        controller.memoryRemediation.resolve({
          taskId: taskA,
          evidenceId: "evidence-a-older",
          staleMemoryId: replacement.replacement.memoryId,
          contradictionClass: "stale canonical source",
          executionFence: controller.captureExecutionFence(taskA),
          progressVector: { scope: "a", replay: true },
          now: 302,
        }).resolution,
      ).toMatchObject({ kind: "rejected", reason: "older_evidence" });
      expect(
        store.memory.activeReplacement({ scope: memoryScopeA, factKey: "ssh.path", now: 303 }),
      ).toMatchObject({ content: { path: "/a/current" } });
    });
  });

  it("quarantines prior-plan memory after a same-task objective correction", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-stale-objective",
        factKey: "ssh.path",
        path: "/objective/original",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-before-correction",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/objective/replacement" },
        observedAt: 200,
      });
      correctMemoryTestTask(controller, memoryScopeA);
      expect(() =>
        store.memory.resolveContradiction({
          taskId,
          evidenceId: "evidence-before-correction",
          staleMemoryId: "memory-stale-objective",
          contradictionClass: "stale canonical source",
          executionFence: controller.captureExecutionFence(taskId),
          now: 201,
        }),
      ).toThrow(/GOVERNOR_EVIDENCE_NOT_CURRENT/u);
      expect(
        store.memory.activeReplacement({ scope: memoryScopeA, factKey: "ssh.path", now: 202 }),
      ).toBeNull();
      expect(store.memory.retrieveAudit({ scope: memoryScopeA })).toEqual([
        expect.objectContaining({ memoryId: "memory-stale-objective", status: "quarantined" }),
      ]);
    });
  });

  it("records a later correction as another immutable revision in the same remediation", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-revision-0",
        factKey: "ssh.path",
        path: "/revision/0",
        observedAt: 100,
        sourceKind: "structured_external",
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-revision-1",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/revision/1" },
        observedAt: 200,
      });
      const first = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-revision-1",
        staleMemoryId: "memory-revision-0",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { revision: 1 },
        now: 201,
      }).resolution;
      if (first.kind !== "retired") {
        throw new Error("expected first revision");
      }
      const firstEffectId = first.remediation.repairEffectId;
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-revision-2",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/revision/2" },
        observedAt: 300,
      });
      const second = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-revision-2",
        staleMemoryId: first.replacement.memoryId,
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { revision: 2 },
        now: 301,
      }).resolution;
      if (second.kind !== "retired") {
        throw new Error("expected second revision");
      }
      expect(second.remediation.repairEffectId).not.toBe(firstEffectId);
      expect(store.memory.listRemediations(memoryScopeA)).toMatchObject([
        { investigationCount: 2, replacementMemoryId: second.replacement.memoryId },
      ]);
      expect(store.memory.retrieveAudit({ scope: memoryScopeA })).toMatchObject([
        { memoryId: "memory-revision-0", status: "superseded" },
        {
          memoryId: first.replacement.memoryId,
          status: "superseded",
          supersedesId: "memory-revision-0",
        },
        {
          memoryId: second.replacement.memoryId,
          status: "verified",
          supersedesId: first.replacement.memoryId,
          content: { path: "/revision/2" },
        },
      ]);
    });
  });

  it("deduplicates ambiguous conflicts without choosing a winner", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-ambiguous",
        factKey: "ssh.path",
        path: "/first",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-ambiguous",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/second" },
        observedAt: 100,
        sourceKind: "tool",
      });
      const resolve = () =>
        controller.memoryRemediation.resolve({
          taskId,
          evidenceId: "evidence-ambiguous",
          staleMemoryId: "memory-ambiguous",
          contradictionClass: "conflicting canonical source",
          executionFence: controller.captureExecutionFence(taskId),
          progressVector: { conflict: true },
          now: 101,
        }).resolution;
      expect(resolve()).toMatchObject({ kind: "unresolved" });
      expect(resolve()).toMatchObject({ kind: "unresolved" });
      expect(store.memory.retrieve({ scope: memoryScopeA, now: 102 })).toMatchObject([
        { memoryId: "memory-ambiguous", status: "verified", content: { path: "/first" } },
      ]);
      expect(store.memory.listRemediations(memoryScopeA)).toMatchObject([
        { status: "unresolved", investigationCount: 1 },
      ]);
      expect(store.actionIntents.listPendingIds(taskId, 1)).toEqual([]);
    });
  });
});
