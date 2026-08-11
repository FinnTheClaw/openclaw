// Proves canonical repair admission, failure containment, and evidence-only closure.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  governorMemoryFactPredicate,
  governorMemoryRepairPredicate,
} from "./memory-contradiction-policy.js";
import {
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
        scope: memoryScopeA,
        memoryId: "memory-repair-old",
        factKey: "ssh.path",
        path: "/old",
        observedAt: 100,
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
      controller.recordAdmittedToolOutcome({
        taskId,
        intent: claim.intent,
        workerId: "memory-worker",
        claimEpoch: claim.intent.claimEpoch,
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
      controller.recordAdmittedToolOutcome({
        taskId,
        intent: failedClaim.intent,
        workerId: "failing-memory-worker",
        claimEpoch: failedClaim.intent.claimEpoch,
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
});
