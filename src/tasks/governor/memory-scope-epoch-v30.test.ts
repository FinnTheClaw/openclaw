// Proves scope-epoch advancement revokes every old-epoch memory access path.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { GovernorController } from "./controller.js";
import {
  governorMemoryFactPredicate,
  governorMemoryRepairPredicate,
} from "./memory-contradiction-policy.js";
import {
  memoryScopeA,
  memoryTestRegistry,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { createGovernorTestStore } from "./test-broker.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor V30 current scope epoch revocation", () => {
  it("revokes epoch zero across recall, duplicate, verification, restart, and retry", async () => {
    await withMemoryTestHarness((harness) => {
      const factKey = "fixture.scope.epoch";
      const taskId = startMemoryTestTask(harness.controller, memoryScopeA);
      seedMemoryFact({
        store: harness.store,
        broker: harness.broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-epoch-zero-stale",
        factKey,
        path: "/fixture/epoch-zero/stale",
        observedAt: 100,
        sourceKind: "structured_external",
      });
      persistMemoryEvidence({
        store: harness.store,
        broker: harness.broker,
        taskId,
        evidenceId: "evidence-epoch-zero-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate(factKey),
        value: { path: "/fixture/epoch-zero/current" },
        observedAt: 200,
      });
      const repaired = harness.controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-epoch-zero-current",
        staleMemoryId: "memory-epoch-zero-stale",
        contradictionClass: "stale canonical source",
        executionFence: harness.controller.captureExecutionFence(taskId),
        progressVector: { epoch: 0 },
        now: 201,
      }).resolution;
      if (repaired.kind !== "retired" || !repaired.remediation.replacementMemoryId) {
        throw new Error("failed to create V30 epoch fixture");
      }
      expect(
        harness.store.memory.activeReplacement({ scope: memoryScopeA, factKey, now: 202 }),
      ).toMatchObject({ scopeEpoch: 0, content: { path: "/fixture/epoch-zero/current" } });

      expect(
        harness.store.memory.forget({
          memoryId: repaired.remediation.replacementMemoryId,
          scope: memoryScopeA,
          expectedScopeEpoch: 0,
          now: 210,
        }),
      ).toMatchObject({ status: "deleted", scopeEpoch: 1 });
      expect(harness.store.memory.getScopeEpoch(memoryScopeA)).toBe(1);
      for (let index = 0; index < 100; index += 1) {
        expect(
          harness.store.memory.activeReplacement({
            scope: memoryScopeA,
            factKey,
            now: 211 + index,
          }),
        ).toBeNull();
      }
      expect(
        harness.store.memory.resolveContradiction({
          taskId,
          evidenceId: "evidence-epoch-zero-current",
          staleMemoryId: "memory-epoch-zero-stale",
          contradictionClass: "stale canonical source",
          executionFence: harness.controller.captureExecutionFence(taskId),
          now: 320,
        }),
      ).toEqual({ kind: "rejected", reason: "state_conflict" });

      persistMemoryEvidence({
        store: harness.store,
        broker: harness.broker,
        taskId,
        evidenceId: "evidence-epoch-zero-verification",
        criterionId: "repair-verified",
        predicate: governorMemoryRepairPredicate(factKey),
        value: { path: "/fixture/epoch-zero/current" },
        observedAt: 321,
      });
      expect(() =>
        harness.store.memory.verifyRepair({
          taskId,
          evidenceId: "evidence-epoch-zero-verification",
          fingerprint: repaired.remediation.contradictionFingerprint,
          now: 322,
          guard: {
            taskId,
            executionFence: harness.controller.captureExecutionFence(taskId),
            expectedStatus: repaired.remediation.status,
            expectedUpdatedAt: repaired.remediation.updatedAt,
          },
        }),
      ).toThrow("GOVERNOR_MEMORY_REPLACEMENT_NOT_CURRENT");
      expect(
        harness.store.memory.promoteVerified({
          taskId,
          evidenceId: "evidence-epoch-zero-current",
          memoryId: "memory-epoch-zero-replay",
          factKey,
          scope: memoryScopeA,
          expectedScopeEpoch: 0,
          now: 323,
        }),
      ).toEqual({ stored: false, reason: "scope_epoch_conflict", currentEpoch: 1 });
      expect(harness.store.memory.listRemediations(memoryScopeA)).toEqual([
        expect.objectContaining({ investigationCount: 1 }),
      ]);

      closeOpenClawStateDatabase();
      const capabilities = memoryTestRegistry();
      const restarted = createGovernorTestStore({ stateDir: harness.stateDir, capabilities });
      const controller = new GovernorController(restarted.store, capabilities);
      expect(restarted.store.memory.getScopeEpoch(memoryScopeA)).toBe(1);
      expect(
        restarted.store.memory.activeReplacement({ scope: memoryScopeA, factKey, now: 330 }),
      ).toBeNull();

      seedMemoryFact({
        store: restarted.store,
        broker: restarted.broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-epoch-one-stale",
        factKey,
        path: "/fixture/epoch-one/stale",
        observedAt: 400,
        expectedScopeEpoch: 1,
        sourceKind: "structured_external",
      });
      persistMemoryEvidence({
        store: restarted.store,
        broker: restarted.broker,
        taskId,
        evidenceId: "evidence-epoch-one-current",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate(factKey),
        value: { path: "/fixture/epoch-one/current" },
        observedAt: 500,
      });
      const epochOne = controller.memoryRemediation.resolve({
        taskId,
        evidenceId: "evidence-epoch-one-current",
        staleMemoryId: "memory-epoch-one-stale",
        contradictionClass: "stale canonical source",
        executionFence: controller.captureExecutionFence(taskId),
        progressVector: { epoch: 1 },
        now: 501,
      }).resolution;
      expect(epochOne).toMatchObject({
        kind: "retired",
        replacement: {
          scopeEpoch: 1,
          content: { path: "/fixture/epoch-one/current" },
        },
      });
      expect(
        restarted.store.memory.activeReplacement({ scope: memoryScopeA, factKey, now: 502 }),
      ).toMatchObject({ scopeEpoch: 1, content: { path: "/fixture/epoch-one/current" } });
    });
  });
});
