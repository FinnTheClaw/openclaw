// Verifies exact-scope memory isolation, evidence-only promotion, epochs, and secret gates.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { GovernorController } from "./controller.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  correctMemoryTestTask,
  memoryTestRegistry,
  persistMemoryEvidence,
  startMemoryTestTask,
  withMemoryTestHarness,
  type MemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import {
  assertGovernorBoundarySafe,
  GovernorSecretRejectedError,
  scanGovernorSecrets,
  type GovernorSecretBoundary,
} from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import { createGovernorTestStore } from "./test-broker.js";
import type { GovernorTaskId, GovernorTaskScope } from "./types.js";

const scopeA: GovernorTaskScope = {
  principalId: "principal-a",
  channel: "synthetic",
  accountId: "account-a",
  conversationId: "conversation-a",
  sessionId: "session-a",
  agentId: "agent-a",
  workspaceId: "workspace-a",
};

const scopeB: GovernorTaskScope = {
  ...scopeA,
  principalId: "principal-b",
  conversationId: "conversation-b",
  sessionId: "session-b",
};

function promote(params: {
  harness: MemoryTestHarness;
  taskId: GovernorTaskId;
  scope: GovernorTaskScope;
  memoryId: string;
  factKey: string;
  content: GovernorJsonValue;
  observedAt: number;
  freshnessExpiresAt?: number;
  sourceKind?: "tool" | "structured_external" | "authenticated_user";
}) {
  const evidenceId = `evidence-${params.memoryId}`;
  persistMemoryEvidence({
    store: params.harness.store,
    broker: params.harness.broker,
    taskId: params.taskId,
    evidenceId,
    criterionId: "memory-observed",
    predicate: governorMemoryFactPredicate(params.factKey),
    value: params.content,
    observedAt: params.observedAt,
    sourceKind: params.sourceKind ?? "structured_external",
  });
  return params.harness.store.memory.promoteVerified({
    taskId: params.taskId,
    evidenceId,
    memoryId: params.memoryId,
    factKey: params.factKey,
    scope: params.scope,
    expectedScopeEpoch: params.harness.store.memory.getScopeEpoch(params.scope),
    ...(params.freshnessExpiresAt === undefined
      ? {}
      : { freshnessExpiresAt: params.freshnessExpiresAt }),
    now: params.observedAt,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor memory integrity", () => {
  it("rejects one fake secret canary at every outbound boundary", () => {
    const boundaries: GovernorSecretBoundary[] = ["model", "memory", "embedding", "session", "log"];
    const payload = { note: "GOVERNOR_SECRET_CANARY_fixture_only" };
    for (const boundary of boundaries) {
      expect(() => assertGovernorBoundarySafe(boundary, payload)).toThrow(
        GovernorSecretRejectedError,
      );
    }
    const scan = scanGovernorSecrets(payload);
    expect(scan.safe).toBe(false);
    expect(JSON.stringify(scan.redacted)).not.toContain("CANARY_fixture_only");
  });

  it("accepts only candidates or current host-admitted evidence and isolates scopes after restart", async () => {
    await withMemoryTestHarness(async (harness) => {
      const taskA = startMemoryTestTask(harness.controller, scopeA, 1);
      const taskB = startMemoryTestTask(harness.controller, scopeB, 2);
      expect(
        promote({
          harness,
          taskId: taskA,
          scope: scopeA,
          memoryId: "memory-a",
          factKey: "inventory.label",
          content: { sharedLabel: "collision", value: "scope-a" },
          observedAt: 100,
        }).stored,
      ).toBe(true);
      expect(
        promote({
          harness,
          taskId: taskB,
          scope: scopeB,
          memoryId: "memory-b",
          factKey: "inventory.label",
          content: { sharedLabel: "collision", value: "scope-b" },
          observedAt: 102,
          sourceKind: "authenticated_user",
        }).stored,
      ).toBe(true);
      expect(
        harness.store.memory.retrieve({ scope: scopeA, now: 103 }).map((m) => m.memoryId),
      ).toEqual(["memory-a"]);
      expect(
        harness.store.memory.retrieve({ scope: scopeB, now: 103 }).map((m) => m.memoryId),
      ).toEqual(["memory-b"]);
      expect(() =>
        (harness.store.memory.storeCandidate as (value: unknown) => unknown)({
          memoryId: "forged-verified",
          factKey: "inventory.label",
          scope: scopeA,
          expectedScopeEpoch: 0,
          content: { value: "forged" },
          now: 103,
          requestedStatus: "verified",
          sourceKind: "structured_external",
          confidence: 1,
          sourceRef: "caller-asserted",
        }),
      ).toThrow("GOVERNOR_MEMORY_INPUT_FIELD_INVALID");

      closeOpenClawStateDatabase();
      const restarted = createGovernorTestStore({
        stateDir: harness.stateDir,
        capabilities: memoryTestRegistry(),
      });
      expect(
        restarted.store.memory.retrieve({ scope: scopeA, now: 104 }).map((m) => m.memoryId),
      ).toEqual(["memory-a"]);
      expect(
        restarted.store.memory.retrieve({ scope: scopeB, now: 104 }).map((m) => m.memoryId),
      ).toEqual(["memory-b"]);
    });
  });

  it("tombstones transactionally and fences a stale candidate writer", async () => {
    await withMemoryTestHarness(async (harness) => {
      const taskId = startMemoryTestTask(harness.controller, scopeA);
      for (const memoryId of ["memory-forget", "memory-keep"]) {
        expect(
          promote({
            harness,
            taskId,
            scope: scopeA,
            memoryId,
            factKey: `fixture.${memoryId}`,
            content: { memoryId },
            observedAt: memoryId === "memory-forget" ? 100 : 101,
            sourceKind: "tool",
          }).stored,
        ).toBe(true);
      }
      expect(
        harness.store.memory.forget({
          memoryId: "memory-forget",
          scope: scopeA,
          expectedScopeEpoch: 0,
          now: 110,
        }),
      ).toMatchObject({ status: "deleted", scopeEpoch: 1 });
      expect(
        harness.store.memory.storeCandidate({
          memoryId: "stale-resurrection",
          factKey: "fixture.memory-forget",
          scope: scopeA,
          expectedScopeEpoch: 0,
          content: { value: "must-not-return" },
          now: 112,
        }),
      ).toEqual({ stored: false, reason: "scope_epoch_conflict", currentEpoch: 1 });
      expect(
        harness.store.memory.retrieve({ scope: scopeA, now: 113 }).map((m) => m.memoryId),
      ).toEqual([]);
      expect(harness.store.memory.retrieveAudit({ scope: scopeA })).toEqual([
        expect.objectContaining({ memoryId: "memory-forget", status: "tombstoned" }),
        expect.objectContaining({ memoryId: "memory-keep", status: "quarantined" }),
      ]);
    });
  });

  it("retires expired authority before backend retirement and accepts a newer observation", async () => {
    await withMemoryTestHarness(async (harness) => {
      const firstTask = startMemoryTestTask(harness.controller, scopeA, 1);
      expect(
        promote({
          harness,
          taskId: firstTask,
          scope: scopeA,
          memoryId: "memory-expiring",
          factKey: "fixture.expiring",
          content: { value: "old" },
          observedAt: 100,
          freshnessExpiresAt: 102,
        }).stored,
      ).toBe(true);
      expect(harness.store.memory.retrieve({ scope: scopeA, now: 103 })).toEqual([]);
      expect(harness.store.memory.retrieveAudit({ scope: scopeA })).toEqual([
        expect.objectContaining({ memoryId: "memory-expiring", status: "tombstoned" }),
      ]);
      const retiredScopeKey = harness.store.memory.retrieveAudit({ scope: scopeA })[0]!.scopeKey;
      const beforeRestart = harness.broker.memoryAuthority.state(
        retiredScopeKey,
        "fixture.expiring",
      );
      expect(beforeRestart).toMatchObject({
        generation: 2,
        status: "retired",
        ordering: { observedAt: 102, recordedAt: 103 },
        retirementDecision: {
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 102,
          issuedAt: 103,
          reason: "expiry",
        },
      });
      closeOpenClawStateDatabase();
      const restartedCapabilities = memoryTestRegistry();
      const restarted = createGovernorTestStore({
        stateDir: harness.stateDir,
        capabilities: restartedCapabilities,
      });
      const restartedHarness = {
        ...restarted,
        controller: new GovernorController(restarted.store, restartedCapabilities),
        stateDir: harness.stateDir,
      } as MemoryTestHarness;
      expect(
        restartedHarness.broker.memoryAuthority.state(retiredScopeKey, "fixture.expiring"),
      ).toEqual(beforeRestart);
      const replacementTask = startMemoryTestTask(restartedHarness.controller, scopeA, 2);
      expect(
        promote({
          harness: restartedHarness,
          taskId: replacementTask,
          scope: scopeA,
          memoryId: "memory-reobserved",
          factKey: "fixture.expiring",
          content: { value: "new" },
          observedAt: 200,
          freshnessExpiresAt: 300,
        }).stored,
      ).toBe(true);
      expect(
        restartedHarness.store.memory.retrieve({ scope: scopeA, now: 201 }).map((m) => m.memoryId),
      ).toEqual(["memory-reobserved"]);
    });
  });

  it("rejects secret-like candidate content before durable insertion", async () => {
    await withMemoryTestHarness(async ({ store }) => {
      expect(() =>
        store.memory.storeCandidate({
          memoryId: "memory-secret",
          factKey: "fixture.secret",
          scope: scopeA,
          expectedScopeEpoch: 0,
          content: { token: "fake-value-for-rejection" },
          now: 100,
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.memory.retrieve({ scope: scopeA, now: 101 })).toEqual([]);
    });
  });

  it("rejects stale signed evidence and exposes no lower-level verified write path", async () => {
    await withMemoryTestHarness(async (harness) => {
      const taskId = startMemoryTestTask(harness.controller, scopeA);
      persistMemoryEvidence({
        store: harness.store,
        broker: harness.broker,
        taskId,
        evidenceId: "evidence-before-correction",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("fixture.stale-evidence"),
        value: { verified: "old-plan" },
        observedAt: 100,
      });
      correctMemoryTestTask(harness.controller, scopeA);
      expect(
        harness.store.memory.promoteVerified({
          taskId,
          evidenceId: "evidence-before-correction",
          memoryId: "memory-stale-evidence",
          factKey: "fixture.stale-evidence",
          scope: scopeA,
          expectedScopeEpoch: 0,
          now: 101,
        }),
      ).toEqual({ stored: false, reason: "provenance_rejected", currentEpoch: 0 });
      expect("storeVerifiedEvidence" in harness.store.memory).toBe(false);
      expect(harness.store.memory.retrieve({ scope: scopeA, now: 102 })).toEqual([]);
    });
  });

  it("quarantines direct database tampering without wedging recall", async () => {
    await withMemoryTestHarness(async (harness) => {
      const taskId = startMemoryTestTask(harness.controller, scopeA);
      expect(
        promote({
          harness,
          taskId,
          scope: scopeA,
          memoryId: "memory-direct-tamper",
          factKey: "fixture.direct-tamper",
          content: { verified: true },
          observedAt: 100,
        }).stored,
      ).toBe(true);
      const { db } = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: harness.stateDir },
      });
      db.prepare(
        `UPDATE governor_memories
            SET verified_evidence_id = NULL,
                verified_evidence_digest = NULL,
                verified_evidence_semantic_digest = NULL
          WHERE memory_id = ?`,
      ).run("memory-direct-tamper");
      expect(harness.store.memory.retrieve({ scope: scopeA, now: 101 })).toEqual([]);
      expect(harness.store.memory.retrieveAudit({ scope: scopeA })).toEqual([
        expect.objectContaining({ memoryId: "memory-direct-tamper", status: "quarantined" }),
      ]);
    });
  });

  it("quarantines unverifiable legacy verified rows without wedging normal recall", async () => {
    await withMemoryTestHarness(async (harness) => {
      expect(
        harness.store.memory.storeCandidate({
          memoryId: "legacy-unverifiable-memory",
          factKey: "fixture.legacy",
          scope: scopeA,
          expectedScopeEpoch: 0,
          content: { legacy: true },
          now: 100,
        }).stored,
      ).toBe(true);
      openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: harness.stateDir },
      })
        .db.prepare("UPDATE governor_memories SET status = 'verified' WHERE memory_id = ?")
        .run("legacy-unverifiable-memory");
      initializeGovernorStateSchema({
        env: { OPENCLAW_STATE_DIR: harness.stateDir },
      });
      expect(harness.store.memory.retrieve({ scope: scopeA, now: 101 })).toEqual([]);
      expect(harness.store.memory.retrieveAudit({ scope: scopeA })).toEqual([
        expect.objectContaining({
          memoryId: "legacy-unverifiable-memory",
          status: "quarantined",
        }),
      ]);
    });
  });
});
