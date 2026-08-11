// Proves remediation follows the stale canonical source across correcting observers.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { GovernorController } from "./controller.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  memoryRepairAction,
  memoryScopeA,
  memoryTestRegistry,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { createGovernorTestStore } from "./test-broker.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor canonical memory remediation source", () => {
  it("deduplicates observers against the stale source and preserves recall after restart", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const stale = seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-canonical-source-a",
        factKey: "ssh.path",
        path: "/legacy/key",
        observedAt: 100,
        sourceKind: "structured_external",
        sourceIdentity: "canonical-source-a",
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-observer-b",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/verified/key" },
        observedAt: 200,
        sourceKind: "structured_external",
        sourceIdentity: "observer-b",
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-observer-c",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/verified/key" },
        observedAt: 200,
        sourceKind: "structured_external",
        sourceIdentity: "observer-c",
      });
      const fence = controller.captureExecutionFence(taskId);
      const [first, second] = await Promise.all([
        Promise.resolve().then(() =>
          controller.memoryRemediation.resolve({
            taskId,
            evidenceId: "evidence-observer-b",
            staleMemoryId: stale.memoryId,
            contradictionClass: "stale canonical source",
            executionFence: fence,
            progressVector: { observer: "b" },
            repairAction: memoryRepairAction(),
            freshnessExpiresAt: 500,
            now: 201,
          }),
        ),
        Promise.resolve().then(() =>
          controller.memoryRemediation.resolve({
            taskId,
            evidenceId: "evidence-observer-c",
            staleMemoryId: stale.memoryId,
            contradictionClass: "stale canonical source",
            executionFence: fence,
            progressVector: { observer: "c" },
            repairAction: memoryRepairAction(),
            freshnessExpiresAt: 500,
            now: 202,
          }),
        ),
      ]);
      expect([first.resolution.kind, second.resolution.kind].toSorted()).toEqual([
        "duplicate",
        "retired",
      ]);
      const remediation = store.memory.listRemediations(memoryScopeA);
      expect(remediation).toHaveLength(1);
      const current = remediation[0];
      if (!current) {
        throw new Error("expected remediation");
      }
      const observerEvidence = store
        .listEvidence(taskId)
        .find((evidence) => evidence.evidenceId === current.evidenceId);
      expect(current.canonicalSourceRef).toBe(stale.provenance.sourceRef);
      expect(current.canonicalSourceRef).not.toBe(observerEvidence?.sourceIdentity);
      expect(store.memory.retrieve({ scope: memoryScopeA, now: 250 })).toMatchObject([
        { status: "verified", content: { path: "/verified/key" } },
      ]);

      closeOpenClawStateDatabase();
      const restartedCapabilities = memoryTestRegistry();
      const restarted = createGovernorTestStore({ stateDir, capabilities: restartedCapabilities });
      const restartedController = new GovernorController(restarted.store, restartedCapabilities);
      expect(restarted.store.memory.listRemediations(memoryScopeA)).toHaveLength(1);
      expect(restarted.store.memory.retrieve({ scope: memoryScopeA, now: 251 })).toMatchObject([
        { status: "verified", content: { path: "/verified/key" } },
      ]);
      const replay = restartedController.memoryRemediation.resolve({
        taskId,
        evidenceId: current.evidenceId,
        staleMemoryId: stale.memoryId,
        contradictionClass: "stale canonical source",
        executionFence: restartedController.captureExecutionFence(taskId),
        progressVector: { replay: true },
        repairAction: memoryRepairAction(),
        now: 252,
      });
      expect(replay.resolution.kind).toBe("duplicate");
      expect(restarted.store.memory.listRemediations(memoryScopeA)).toHaveLength(1);
    });
  });
});
