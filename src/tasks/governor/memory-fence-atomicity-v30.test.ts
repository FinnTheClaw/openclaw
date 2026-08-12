// Proves stale execution fences cannot mutate memory or remediation state.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  memoryScopeA,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
  type MemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import type { GovernorTaskId } from "./types.js";

function prepareContradiction(harness: MemoryTestHarness, suffix: string) {
  const taskId = startMemoryTestTask(harness.controller, memoryScopeA);
  const factKey = `fixture.fence.${suffix}`;
  seedMemoryFact({
    store: harness.store,
    broker: harness.broker,
    taskId,
    scope: memoryScopeA,
    memoryId: `memory-fence-${suffix}`,
    factKey,
    path: `/fixture/${suffix}/old`,
    observedAt: 100,
    sourceKind: "structured_external",
  });
  persistMemoryEvidence({
    store: harness.store,
    broker: harness.broker,
    taskId,
    evidenceId: `evidence-fence-${suffix}`,
    criterionId: "memory-observed",
    predicate: governorMemoryFactPredicate(factKey),
    value: { path: `/fixture/${suffix}/current` },
    observedAt: 200,
  });
  return { taskId, factKey, staleMemoryId: `memory-fence-${suffix}` };
}

function durableMemoryState(harness: MemoryTestHarness) {
  const { db } = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: harness.stateDir },
  });
  return {
    memories: db.prepare("SELECT * FROM governor_memories ORDER BY memory_id").all(),
    repairs: db
      .prepare("SELECT * FROM governor_memory_remediations ORDER BY contradiction_fingerprint")
      .all(),
  };
}

function reclaim(harness: MemoryTestHarness, taskId: GovernorTaskId, now: number) {
  const task = harness.store.loadTask(taskId);
  if (!task) {
    throw new Error("missing V30 fence fixture task");
  }
  return harness.controller.reclaimTaskLease({
    taskId,
    expectedTaskVersion: task.taskVersion,
    expectedLeaseEpoch: task.leaseEpoch,
    now,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor V30 memory pre-mutation fence atomicity", () => {
  it("rejects a reclaimed lease before any memory, repair, or authority mutation", async () => {
    await withMemoryTestHarness((harness) => {
      const fixture = prepareContradiction(harness, "reclaim-first");
      const staleFence = harness.controller.captureExecutionFence(fixture.taskId);
      const scopeKey = harness.store.loadTask(fixture.taskId)?.scopeKey;
      if (!scopeKey) {
        throw new Error("missing V30 scope key");
      }
      const beforeRows = durableMemoryState(harness);
      const beforeAuthority = harness.broker.memoryAuthority.state(scopeKey, fixture.factKey);
      reclaim(harness, fixture.taskId, 210);

      expect(() =>
        harness.controller.memoryRemediation.resolve({
          taskId: fixture.taskId,
          evidenceId: "evidence-fence-reclaim-first",
          staleMemoryId: fixture.staleMemoryId,
          contradictionClass: "stale canonical source",
          executionFence: staleFence,
          progressVector: { phase: "stale" },
          now: 211,
        }),
      ).toThrow("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
      expect(durableMemoryState(harness)).toEqual(beforeRows);
      expect(harness.broker.memoryAuthority.state(scopeKey, fixture.factKey)).toEqual(
        beforeAuthority,
      );
    });
  });

  it("linearizes a current repair once and makes reclaimed duplicate/replay audit-only", async () => {
    await withMemoryTestHarness((harness) => {
      const fixture = prepareContradiction(harness, "write-first");
      const fence = harness.controller.captureExecutionFence(fixture.taskId);
      const first = harness.controller.memoryRemediation.resolve({
        taskId: fixture.taskId,
        evidenceId: "evidence-fence-write-first",
        staleMemoryId: fixture.staleMemoryId,
        contradictionClass: "stale canonical source",
        executionFence: fence,
        progressVector: { phase: "current" },
        now: 201,
      });
      expect(first.resolution.kind).toBe("retired");
      const committed = durableMemoryState(harness);
      const exactRetry = harness.controller.memoryRemediation.resolve({
        taskId: fixture.taskId,
        evidenceId: "evidence-fence-write-first",
        staleMemoryId: fixture.staleMemoryId,
        contradictionClass: "stale canonical source",
        executionFence: fence,
        progressVector: { phase: "current" },
        now: 202,
      });
      expect(exactRetry.resolution.kind).toBe("duplicate");
      expect(durableMemoryState(harness)).toEqual(committed);

      reclaim(harness, fixture.taskId, 210);
      expect(() =>
        harness.controller.memoryRemediation.resolve({
          taskId: fixture.taskId,
          evidenceId: "evidence-fence-write-first",
          staleMemoryId: fixture.staleMemoryId,
          contradictionClass: "stale canonical source",
          executionFence: fence,
          progressVector: { phase: "late-replay" },
          operatorRequested: true,
          repairAction: {
            criterionId: "repair-verified",
            capability: "synthetic.memory.repair",
            capabilityVersion: "1",
            canonicalTarget: "fixture://canonical-memory-source",
            expectedEvidence: "fresh exact value",
            sourceRank: "structured_exact",
            stopCondition: "source is current",
            argumentsDigest: "a".repeat(64),
          },
          now: 211,
        }),
      ).toThrow("GOVERNOR_MEMORY_REPAIR_FENCE_REJECTED");
      expect(durableMemoryState(harness)).toEqual(committed);
    });
  });
});
