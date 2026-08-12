// Proves repair completion and duplicate resolution require a live authoritative replacement.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  governorMemoryFactPredicate,
  governorMemoryRepairPredicate,
} from "./memory-contradiction-policy.js";
import {
  memoryScopeA,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
  type MemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";
import type { GovernorTaskId } from "./types.js";

type RepairFixture = {
  taskId: GovernorTaskId;
  factKey: string;
  remediation: GovernorMemoryRemediation;
};

function createRepairFixture(harness: MemoryTestHarness, suffix: string): RepairFixture {
  const taskId = startMemoryTestTask(harness.controller, memoryScopeA);
  const factKey = `fixture.repair.${suffix}`;
  seedMemoryFact({
    store: harness.store,
    broker: harness.broker,
    taskId,
    scope: memoryScopeA,
    memoryId: `memory-stale-${suffix}`,
    factKey,
    path: `/fixture/${suffix}/stale`,
    observedAt: 100,
    sourceKind: "structured_external",
  });
  persistMemoryEvidence({
    store: harness.store,
    broker: harness.broker,
    taskId,
    evidenceId: `evidence-current-${suffix}`,
    criterionId: "memory-observed",
    predicate: governorMemoryFactPredicate(factKey),
    value: { path: `/fixture/${suffix}/current` },
    observedAt: 200,
  });
  const resolution = harness.controller.memoryRemediation.resolve({
    taskId,
    evidenceId: `evidence-current-${suffix}`,
    staleMemoryId: `memory-stale-${suffix}`,
    contradictionClass: "stale canonical source",
    executionFence: harness.controller.captureExecutionFence(taskId),
    progressVector: { repair: "unavailable" },
    now: 201,
  }).resolution;
  if (resolution.kind !== "retired" || !resolution.remediation.replacementMemoryId) {
    throw new Error("expected a replacement-backed repair fixture");
  }
  return { taskId, factKey, remediation: resolution.remediation };
}

function persistVerification(harness: MemoryTestHarness, fixture: RepairFixture): string {
  const evidenceId = `evidence-verified-${fixture.factKey}`;
  persistMemoryEvidence({
    store: harness.store,
    broker: harness.broker,
    taskId: fixture.taskId,
    evidenceId,
    criterionId: "repair-verified",
    predicate: governorMemoryRepairPredicate(fixture.factKey),
    value: { path: `/fixture/${fixture.factKey.split(".").at(-1)}/current` },
    observedAt: 300,
  });
  return evidenceId;
}

function verifyRepair(harness: MemoryTestHarness, fixture: RepairFixture, evidenceId: string) {
  return harness.store.memory.verifyRepair({
    taskId: fixture.taskId,
    evidenceId,
    fingerprint: fixture.remediation.contradictionFingerprint,
    now: 301,
    guard: {
      taskId: fixture.taskId,
      executionFence: harness.controller.captureExecutionFence(fixture.taskId),
      expectedStatus: fixture.remediation.status,
      expectedUpdatedAt: fixture.remediation.updatedAt,
    },
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor memory repair replacement truth", () => {
  for (const mutation of ["tombstoned", "superseded", "wrong_epoch", "wrong_authority"] as const) {
    it(`rejects ${mutation} replacements before marking repair verified`, async () => {
      await withMemoryTestHarness((harness) => {
        const fixture = createRepairFixture(harness, mutation);
        const replacementId = fixture.remediation.replacementMemoryId!;
        if (mutation === "tombstoned") {
          expect(
            harness.store.memory.forget({
              memoryId: replacementId,
              scope: memoryScopeA,
              expectedScopeEpoch: 0,
              now: 250,
            }),
          ).toMatchObject({ status: "deleted" });
        } else {
          const { db } = openOpenClawStateDatabase({
            env: { OPENCLAW_STATE_DIR: harness.stateDir },
          });
          const update =
            mutation === "superseded"
              ? ["status = 'superseded'"]
              : mutation === "wrong_epoch"
                ? ["scope_epoch = scope_epoch + 1"]
                : ["authority_binding_digest = ?", "f".repeat(64)];
          db.prepare(`UPDATE governor_memories SET ${update[0]} WHERE memory_id = ?`).run(
            ...update.slice(1),
            replacementId,
          );
        }
        const evidenceId = persistVerification(harness, fixture);
        expect(() => verifyRepair(harness, fixture, evidenceId)).toThrow(
          "GOVERNOR_MEMORY_REPLACEMENT_NOT_CURRENT",
        );
        const unchanged = harness.store.memory.loadRemediation(
          fixture.remediation.contradictionFingerprint,
        );
        expect(unchanged).toMatchObject({ status: "blocked" });
        expect(unchanged).not.toHaveProperty("verificationEvidenceId");
      });
    });
  }

  it("rejects invalid replacement rows on both duplicate resolution paths and verification replay", async () => {
    await withMemoryTestHarness((harness) => {
      const fixture = createRepairFixture(harness, "duplicates");
      const replacementId = fixture.remediation.replacementMemoryId!;
      expect(
        harness.store.memory.resolveContradiction({
          taskId: fixture.taskId,
          evidenceId: `evidence-current-duplicates`,
          staleMemoryId: "memory-stale-duplicates",
          contradictionClass: "stale canonical source",
          executionFence: harness.controller.captureExecutionFence(fixture.taskId),
          now: 202,
        }),
      ).toMatchObject({ kind: "duplicate", replacement: { status: "verified" } });
      const evidenceId = persistVerification(harness, fixture);
      const verified = verifyRepair(harness, fixture, evidenceId);
      expect(verified).toMatchObject({ status: "verified" });
      harness.store.memory.forget({
        memoryId: replacementId,
        scope: memoryScopeA,
        expectedScopeEpoch: 0,
        now: 310,
      });
      expect(() =>
        harness.store.memory.verifyRepair({
          taskId: fixture.taskId,
          evidenceId,
          fingerprint: fixture.remediation.contradictionFingerprint,
          now: 311,
          guard: {
            taskId: fixture.taskId,
            executionFence: harness.controller.captureExecutionFence(fixture.taskId),
            expectedStatus: "verified",
            expectedUpdatedAt: 301,
          },
        }),
      ).toThrow("GOVERNOR_MEMORY_REPLACEMENT_NOT_CURRENT");
      expect(
        harness.store.memory.resolveContradiction({
          taskId: fixture.taskId,
          evidenceId: "evidence-current-duplicates",
          staleMemoryId: "memory-stale-duplicates",
          contradictionClass: "stale canonical source",
          executionFence: harness.controller.captureExecutionFence(fixture.taskId),
          now: 312,
        }),
      ).toMatchObject({ kind: "rejected" });

      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: harness.stateDir } });
      db.prepare("UPDATE governor_memories SET status = 'verified' WHERE memory_id = ?").run(
        "memory-stale-duplicates",
      );
      expect(
        harness.store.memory.resolveContradiction({
          taskId: fixture.taskId,
          evidenceId: "evidence-current-duplicates",
          staleMemoryId: "memory-stale-duplicates",
          contradictionClass: "stale canonical source",
          executionFence: harness.controller.captureExecutionFence(fixture.taskId),
          now: 313,
        }),
      ).toMatchObject({ kind: "rejected" });
    });
  });

  it("keeps a genuinely verified replacement reusable without repeated investigation", async () => {
    await withMemoryTestHarness((harness) => {
      const fixture = createRepairFixture(harness, "stable");
      const evidenceId = persistVerification(harness, fixture);
      expect(verifyRepair(harness, fixture, evidenceId)).toMatchObject({ status: "verified" });
      for (let index = 0; index < 100; index += 1) {
        expect(
          harness.store.memory.activeReplacement({
            scope: memoryScopeA,
            factKey: fixture.factKey,
            now: 302 + index,
          }),
        ).toMatchObject({ status: "verified", content: { path: "/fixture/stable/current" } });
      }
      expect(
        harness.store.memory.loadRemediation(fixture.remediation.contradictionFingerprint),
      ).toMatchObject({ status: "verified", investigationCount: 1 });
    });
  });
});
