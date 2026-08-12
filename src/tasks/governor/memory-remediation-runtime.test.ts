// Proves canonical repair admission, failure containment, and evidence-only closure.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  governorMemoryFactPredicate,
  governorMemoryRepairPredicate,
} from "./memory-contradiction-policy.js";
import {
  correctMemoryTestTask,
  memoryRepairAction,
  memoryScopeA,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor memory remediation runtime", () => {
  it("closes an authorized repair only after fresh exact-source verification", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-repair-old",
        factKey: "ssh.path",
        path: "/old",
        observedAt: 100,
        sourceKind: "structured_external",
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-repair-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/new" },
        observedAt: 200,
      });
      const resolution = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-repair-current",
        staleMemoryId: "memory-repair-old",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { repair: "queued" },
        repairAction: memoryRepairAction(),
        now: 201,
      }).resolution;
      if (resolution.kind !== "retired" || !resolution.remediation.repairEffectId) {
        throw new Error("expected queued repair");
      }
      const intent = store.actionIntents.load(taskId, resolution.remediation.repairEffectId);
      if (!intent) {
        throw new Error("expected repair action intent");
      }
      const claim = controller.claimActionIntent({ intent, workerId: "memory-worker", now: 202 });
      if (claim.kind !== "claimed") {
        throw new Error(`expected repair claim, received ${claim.kind}`);
      }
      const started = controller.beginActionEffect({
        intent: claim.intent,
        workerId: "memory-worker",
        claimEpoch: claim.intent.claimEpoch,
        now: 202,
      });
      if (started.kind !== "started") {
        throw new Error("expected repair effect fence");
      }
      controller.recordAdmittedToolOutcome({
        taskId,
        intent: started.intent,
        workerId: "memory-worker",
        claimEpoch: started.intent.claimEpoch,
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "applied",
          verification: "verified",
          summaryCode: "canonical_source_written",
        },
        now: 203,
      });
      expect(
        controller.memoryRemediation.reconcile({
          fingerprint: resolution.remediation.contradictionFingerprint,
          taskId,
          now: 204,
        }),
      ).toMatchObject({ status: "repairing" });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-repair-verified",
        criterionId: "repair-verified",
        predicate: governorMemoryRepairPredicate("ssh.path"),
        value: { path: "/new" },
        observedAt: 300,
      });
      expect(
        controller.memoryRemediation.reconcile({
          fingerprint: resolution.remediation.contradictionFingerprint,
          taskId,
          verificationEvidenceId: "evidence-repair-verified",
          now: 301,
        }),
      ).toMatchObject({
        status: "verified",
        verificationEvidenceId: "evidence-repair-verified",
        closedAt: 301,
      });
    });
  });

  it("keeps failed and unavailable repairs blocked while stale facts stay inactive", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-blocked-old",
        factKey: "ssh.path",
        path: "/old",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-blocked-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/safe" },
        observedAt: 200,
      });
      const result = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-blocked-current",
        staleMemoryId: "memory-blocked-old",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { repair: "unavailable" },
        now: 201,
      });
      expect(result.resolution).toMatchObject({
        kind: "retired",
        remediation: { status: "blocked", blockedReason: "repair_not_available" },
      });
      expect(store.memory.retrieve({ scope: memoryScopeA, now: 202 })).toMatchObject([
        { status: "verified", content: { path: "/safe" } },
      ]);
      expect(store.memory.retrieveAudit({ scope: memoryScopeA })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memoryId: "memory-blocked-old", status: "superseded" }),
        ]),
      );
      expect(
        controller.memoryRemediation.resolve({
          taskId,
          evidenceId: "evidence-blocked-current",
          staleMemoryId: "memory-blocked-old",
          contradictionClass: "stale canonical source",
          executionFence: controller.captureExecutionFence(taskId),
          progressVector: { repair: "operator-retry" },
          repairAction: memoryRepairAction(),
          operatorRequested: true,
          now: 210,
        }),
      ).toMatchObject({
        resolution: { kind: "duplicate", remediation: { status: "queued" } },
        repairAdmission: { accepted: true },
      });

      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-failed-old",
        factKey: "api.endpoint",
        path: "/failed/old",
        observedAt: 300,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-failed-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("api.endpoint"),
        value: { path: "/failed/safe" },
        observedAt: 400,
      });
      const failedResolution = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-failed-current",
        staleMemoryId: "memory-failed-old",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { repair: "will-fail" },
        repairAction: memoryRepairAction(),
        now: 401,
      }).resolution;
      if (failedResolution.kind !== "retired" || !failedResolution.remediation.repairEffectId) {
        throw new Error("expected queued failing repair");
      }
      const failedIntent = store.actionIntents.load(
        taskId,
        failedResolution.remediation.repairEffectId,
      );
      if (!failedIntent) {
        throw new Error("expected failing repair intent");
      }
      const failedClaim = controller.claimActionIntent({
        intent: failedIntent,
        workerId: "failing-memory-worker",
        now: 402,
      });
      if (failedClaim.kind !== "claimed") {
        throw new Error(`expected failing repair claim, received ${failedClaim.kind}`);
      }
      const failedStarted = controller.beginActionEffect({
        intent: failedClaim.intent,
        workerId: "failing-memory-worker",
        claimEpoch: failedClaim.intent.claimEpoch,
        now: 402,
      });
      if (failedStarted.kind !== "started") {
        throw new Error("expected failing repair effect fence");
      }
      controller.recordAdmittedToolOutcome({
        taskId,
        intent: failedStarted.intent,
        workerId: "failing-memory-worker",
        claimEpoch: failedStarted.intent.claimEpoch,
        outcome: {
          transport: "completed",
          semantic: "permanent_failure",
          sideEffect: "none",
          verification: "failed",
          summaryCode: "canonical_source_write_failed",
        },
        now: 403,
      });
      expect(
        controller.memoryRemediation.reconcile({
          fingerprint: failedResolution.remediation.contradictionFingerprint,
          taskId,
          now: 404,
        }),
      ).toMatchObject({ status: "blocked", blockedReason: "repair_permanent_failure" });
      expect(
        store.memory.activeReplacement({ scope: memoryScopeA, factKey: "api.endpoint", now: 405 }),
      ).toMatchObject({ content: { path: "/failed/safe" }, status: "verified" });
    });
  });

  it("fences repair-state writes by the current task generation and compare-and-swap state", async () => {
    await withMemoryTestHarness(({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-repair-cas-old",
        factKey: "fixture.repair.cas",
        path: "/fixture/old",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-repair-cas-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("fixture.repair.cas"),
        value: { path: "/fixture/current" },
        observedAt: 200,
      });
      const staleFence = controller.captureExecutionFence(taskId);
      const resolution = store.memory.resolveContradiction({
        taskId,
        evidenceId: "evidence-repair-cas-current",
        staleMemoryId: "memory-repair-cas-old",
        contradictionClass: "stale canonical source",
        now: 201,
      });
      if (resolution.kind !== "retired") {
        throw new Error("expected queued repair CAS fixture");
      }
      const remediation = resolution.remediation;
      correctMemoryTestTask(controller, memoryScopeA, 2);
      expect(() =>
        store.memory.updateRepairState({
          fingerprint: remediation.contradictionFingerprint,
          status: "blocked",
          blockedReason: "stale_worker",
          now: 202,
          guard: {
            taskId,
            executionFence: staleFence,
            expectedStatus: remediation.status,
            expectedUpdatedAt: remediation.updatedAt,
          },
        }),
      ).toThrow(/REPAIR_FENCE_REJECTED/u);

      const currentFence = controller.captureExecutionFence(taskId);
      expect(() =>
        store.memory.updateRepairState({
          fingerprint: remediation.contradictionFingerprint,
          status: "blocked",
          blockedReason: "current_worker",
          now: 203,
          guard: {
            taskId,
            executionFence: currentFence,
            expectedStatus: remediation.status,
            expectedUpdatedAt: remediation.updatedAt + 1,
          },
        }),
      ).toThrow(/REPAIR_CAS_REJECTED/u);

      const blocked = store.memory.updateRepairState({
        fingerprint: remediation.contradictionFingerprint,
        status: "blocked",
        blockedReason: "current_worker",
        now: 204,
        guard: {
          taskId,
          executionFence: currentFence,
          expectedStatus: remediation.status,
          expectedUpdatedAt: remediation.updatedAt,
        },
      });
      expect(blocked).toMatchObject({ status: "blocked", blockedReason: "current_worker" });
      expect(store.memory.retrieve({ scope: memoryScopeA, now: 205 })).toEqual([]);
      expect(store.memory.retrieveAudit({ scope: memoryScopeA })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: { path: "/fixture/current" } }),
        ]),
      );
    });
  });
});
