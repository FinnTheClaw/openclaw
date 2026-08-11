// Verifies exact-scope memory isolation, provenance, tombstones, epochs, and secret gates.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorMemoryStore } from "./memory-integrity.js";
import {
  assertGovernorBoundarySafe,
  GovernorSecretRejectedError,
  scanGovernorSecrets,
  type GovernorSecretBoundary,
} from "./secret-filter.js";
import { createGovernorIdentityContext, type GovernorTaskScope } from "./types.js";

const identity = createGovernorIdentityContext("synthetic-memory-test-identity-key");

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

async function withMemoryStore(
  run: (params: { store: GovernorMemoryStore; stateDir: string }) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-memory-" },
    async (state) => {
      try {
        await run({
          store: new GovernorMemoryStore({ stateDir: state.stateDir, identity }),
          stateDir: state.stateDir,
        });
      } finally {
        closeOpenClawStateDatabase();
      }
    },
  );
}

afterEach(() => {
  closeOpenClawStateDatabase();
});

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
    expect(scan.findings).toEqual([{ code: "secret_canary", path: "$.note" }]);
  });

  it("isolates colliding contacts across restart and ranks structured evidence first", async () => {
    await withMemoryStore(({ store, stateDir }) => {
      const first = store.store({
        memoryId: "memory-a",
        factKey: "inventory.label",
        scope: scopeA,
        expectedScopeEpoch: 0,
        requestedStatus: "verified",
        sourceKind: "structured_external",
        sourceIdentity: "synthetic.inventory",
        observedAt: 100,
        confidence: 1,
        sensitivity: "normal",
        sourceRef: "fixture://inventory/a",
        content: { sharedLabel: "collision", value: "scope-a" },
        now: 100,
      });
      expect(first.stored).toBe(true);
      const stored = store.retrieve({ scope: scopeA, now: 100 })[0];
      expect(stored?.sourceIdentity).not.toBe("synthetic.inventory");
      expect(stored?.provenance.sourceRef).not.toBe("fixture://inventory/a");
      expect(
        store.store({
          memoryId: "memory-a-unadmitted-replacement",
          factKey: " Inventory / Label ",
          scope: scopeA,
          expectedScopeEpoch: 0,
          requestedStatus: "verified",
          sourceKind: "structured_external",
          sourceIdentity: "synthetic.inventory",
          observedAt: 200,
          confidence: 1,
          sensitivity: "normal",
          sourceRef: "fixture://inventory/a",
          content: { value: "must-use-contradiction-admission" },
          now: 200,
        }),
      ).toMatchObject({ stored: false, reason: "fact_version_conflict" });
      expect(
        store.store({
          memoryId: "memory-a-assistant",
          factKey: "inventory.label",
          scope: scopeA,
          expectedScopeEpoch: 0,
          requestedStatus: "verified",
          sourceKind: "assistant_text",
          sourceIdentity: "assistant",
          observedAt: 101,
          confidence: 1,
          sensitivity: "normal",
          sourceRef: "assistant://claim",
          content: { value: "unsupported" },
          now: 101,
        }),
      ).toMatchObject({ stored: false, reason: "provenance_rejected" });
      const second = store.store({
        memoryId: "memory-b",
        factKey: "inventory.label",
        scope: scopeB,
        expectedScopeEpoch: 0,
        requestedStatus: "verified",
        sourceKind: "authenticated_user",
        sourceIdentity: "synthetic.user",
        observedAt: 102,
        confidence: 0.9,
        sensitivity: "normal",
        sourceRef: "fixture://message/b",
        content: { sharedLabel: "collision", value: "scope-b" },
        now: 102,
      });
      expect(second.stored).toBe(true);
      expect(store.retrieve({ scope: scopeA, now: 103 }).map((item) => item.memoryId)).toEqual([
        "memory-a",
      ]);
      expect(store.retrieve({ scope: scopeB, now: 103 }).map((item) => item.memoryId)).toEqual([
        "memory-b",
      ]);

      closeOpenClawStateDatabase();
      const restarted = new GovernorMemoryStore({ stateDir, identity });
      expect(restarted.retrieve({ scope: scopeA, now: 104 }).map((item) => item.memoryId)).toEqual([
        "memory-a",
      ]);
      expect(restarted.retrieve({ scope: scopeB, now: 104 }).map((item) => item.memoryId)).toEqual([
        "memory-b",
      ]);
    });
  });

  it("tombstones transactionally and fences a stale concurrent writer", async () => {
    await withMemoryStore(({ store }) => {
      for (const memoryId of ["memory-forget", "memory-keep"]) {
        expect(
          store.store({
            memoryId,
            factKey: `fixture.${memoryId}`,
            scope: scopeA,
            expectedScopeEpoch: 0,
            requestedStatus: "verified",
            sourceKind: "tool",
            sourceIdentity: "synthetic.memory",
            observedAt: 100,
            confidence: 0.9,
            sensitivity: "normal",
            sourceRef: `fixture://${memoryId}`,
            content: { memoryId },
            now: 100,
          }).stored,
        ).toBe(true);
      }
      expect(
        store.forget({
          memoryId: "memory-forget",
          scope: scopeA,
          expectedScopeEpoch: 0,
          now: 110,
        }),
      ).toEqual({
        status: "deleted",
        memoryId: "memory-forget",
        scopeEpoch: 1,
        invalidated: ["primary", "scope_epoch"],
      });
      expect(store.retrieve({ scope: scopeA, now: 111 }).map((item) => item.memoryId)).toEqual([
        "memory-keep",
      ]);
      expect(
        store.store({
          memoryId: "stale-resurrection",
          factKey: "fixture.memory-forget",
          scope: scopeA,
          expectedScopeEpoch: 0,
          requestedStatus: "verified",
          sourceKind: "tool",
          sourceIdentity: "stale-writer",
          observedAt: 109,
          confidence: 1,
          sensitivity: "normal",
          sourceRef: "fixture://stale",
          content: { value: "must-not-return" },
          now: 112,
        }),
      ).toEqual({ stored: false, reason: "scope_epoch_conflict", currentEpoch: 1 });
      expect(
        store.forget({
          memoryId: "memory-forget",
          scope: scopeA,
          expectedScopeEpoch: 1,
          now: 113,
        }),
      ).toEqual({ status: "not_found", memoryId: "memory-forget", scopeEpoch: 1 });
    });
  });

  it("rejects secret-like content before durable memory insertion", async () => {
    await withMemoryStore(({ store }) => {
      expect(() =>
        store.store({
          memoryId: "memory-secret",
          factKey: "fixture.secret",
          scope: scopeA,
          expectedScopeEpoch: 0,
          requestedStatus: "candidate",
          sourceKind: "tool",
          sourceIdentity: "synthetic.memory",
          observedAt: 100,
          confidence: 0.5,
          sensitivity: "sensitive",
          sourceRef: "fixture://secret",
          content: { token: "fake-value-for-rejection" },
          now: 100,
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.retrieve({ scope: scopeA, now: 101 })).toEqual([]);
    });
  });
});
