// Attacks every replacement access path with forged canonical and host bindings.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { canonicalGovernorJson, governorDigest } from "./canonical-json.js";
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

type Fixture = {
  taskId: GovernorTaskId;
  factKey: string;
  staleMemoryId: string;
  replacementId: string;
  remediation: GovernorMemoryRemediation;
};
type Tamper =
  | "content"
  | "row_only_rehash"
  | "provenance"
  | "scope_binding"
  | "fact_binding"
  | "source_binding"
  | "freshness_binding"
  | "host_authority"
  | "swapped_record"
  | "malformed_content"
  | "noncanonical_content"
  | "malformed_provenance"
  | "noncanonical_provenance";
type Access = "recall" | "active" | "duplicate" | "verify";

const TAMPERS: readonly Tamper[] = [
  "content",
  "row_only_rehash",
  "provenance",
  "scope_binding",
  "fact_binding",
  "source_binding",
  "freshness_binding",
  "host_authority",
  "swapped_record",
  "malformed_content",
  "noncanonical_content",
  "malformed_provenance",
  "noncanonical_provenance",
];
const ACCESS_PATHS: readonly Access[] = ["recall", "active", "duplicate", "verify"];

function createFixture(harness: MemoryTestHarness, suffix: string): Fixture {
  const taskId = startMemoryTestTask(harness.controller, memoryScopeA);
  const factKey = `fixture.canonical.${suffix}`;
  const staleMemoryId = `memory-canonical-stale-${suffix}`;
  seedMemoryFact({
    store: harness.store,
    broker: harness.broker,
    taskId,
    scope: memoryScopeA,
    memoryId: staleMemoryId,
    factKey,
    path: `/fixture/${suffix}/stale`,
    observedAt: 100,
    sourceKind: "structured_external",
  });
  persistMemoryEvidence({
    store: harness.store,
    broker: harness.broker,
    taskId,
    evidenceId: `evidence-canonical-${suffix}`,
    criterionId: "memory-observed",
    predicate: governorMemoryFactPredicate(factKey),
    value: { path: `/fixture/${suffix}/current` },
    observedAt: 200,
  });
  const result = harness.controller.memoryRemediation.resolve({
    taskId,
    evidenceId: `evidence-canonical-${suffix}`,
    staleMemoryId,
    contradictionClass: "stale canonical source",
    executionFence: harness.controller.captureExecutionFence(taskId),
    progressVector: { fixture: suffix },
    now: 201,
  }).resolution;
  if (result.kind !== "retired" || !result.remediation.replacementMemoryId) {
    throw new Error("failed to create V30 canonical fixture");
  }
  return {
    taskId,
    factKey,
    staleMemoryId,
    replacementId: result.remediation.replacementMemoryId,
    remediation: result.remediation,
  };
}

function memoryRow(db: DatabaseSync, memoryId: string) {
  return db
    .prepare(
      "SELECT content_json, content_digest, provenance_json FROM governor_memories WHERE memory_id = ?",
    )
    .get(memoryId) as {
    content_json: string;
    content_digest: string;
    provenance_json: string;
  };
}

function tamper(harness: MemoryTestHarness, fixture: Fixture, kind: Tamper): void {
  const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: harness.stateDir } });
  const row = memoryRow(db, fixture.replacementId);
  const forged = { path: `/fixture/${kind}/forged` };
  if (kind === "content") {
    db.prepare("UPDATE governor_memories SET content_json = ? WHERE memory_id = ?").run(
      canonicalGovernorJson(forged),
      fixture.replacementId,
    );
  } else if (kind === "row_only_rehash") {
    db.prepare(
      "UPDATE governor_memories SET content_json = ?, content_digest = ? WHERE memory_id = ?",
    ).run(canonicalGovernorJson(forged), governorDigest(forged), fixture.replacementId);
  } else if (kind === "provenance") {
    const provenance = JSON.parse(row.provenance_json) as Record<string, unknown>;
    db.prepare("UPDATE governor_memories SET provenance_json = ? WHERE memory_id = ?").run(
      canonicalGovernorJson({ ...provenance, recordedAt: Number(provenance.recordedAt) + 1 }),
      fixture.replacementId,
    );
  } else if (kind === "scope_binding") {
    db.prepare("UPDATE governor_memories SET scope_key = ? WHERE memory_id = ?").run(
      "gref_forged_scope_binding",
      fixture.replacementId,
    );
  } else if (kind === "fact_binding") {
    db.prepare("UPDATE governor_memories SET fact_key = ? WHERE memory_id = ?").run(
      `${fixture.factKey}.forged`,
      fixture.replacementId,
    );
  } else if (kind === "source_binding") {
    db.prepare("UPDATE governor_memories SET source_kind = ? WHERE memory_id = ?").run(
      "tool",
      fixture.replacementId,
    );
  } else if (kind === "freshness_binding") {
    db.prepare("UPDATE governor_memories SET freshness_expires_at = ? WHERE memory_id = ?").run(
      999_999,
      fixture.replacementId,
    );
  } else if (kind === "host_authority") {
    db.prepare("UPDATE governor_memories SET authority_binding_digest = ? WHERE memory_id = ?").run(
      "f".repeat(64),
      fixture.replacementId,
    );
  } else if (kind === "swapped_record") {
    seedMemoryFact({
      store: harness.store,
      broker: harness.broker,
      taskId: fixture.taskId,
      scope: memoryScopeA,
      memoryId: `memory-swap-${fixture.replacementId}`,
      factKey: `${fixture.factKey}.other`,
      path: "/fixture/swap/other",
      observedAt: 250,
      sourceKind: "structured_external",
    });
    db.prepare(
      `UPDATE governor_memories SET
       content_json = (SELECT content_json FROM governor_memories WHERE memory_id = ?),
       content_digest = (SELECT content_digest FROM governor_memories WHERE memory_id = ?),
       provenance_json = (SELECT provenance_json FROM governor_memories WHERE memory_id = ?),
       source_identity = (SELECT source_identity FROM governor_memories WHERE memory_id = ?),
       observed_at = (SELECT observed_at FROM governor_memories WHERE memory_id = ?),
       verified_evidence_id = (SELECT verified_evidence_id FROM governor_memories WHERE memory_id = ?),
       verified_evidence_digest = (SELECT verified_evidence_digest FROM governor_memories WHERE memory_id = ?),
       verified_evidence_semantic_digest =
         (SELECT verified_evidence_semantic_digest FROM governor_memories WHERE memory_id = ?)
       WHERE memory_id = ?`,
    ).run(
      ...Array.from({ length: 8 }, () => `memory-swap-${fixture.replacementId}`),
      fixture.replacementId,
    );
  } else if (kind === "malformed_content") {
    db.prepare("UPDATE governor_memories SET content_json = ? WHERE memory_id = ?").run(
      "{",
      fixture.replacementId,
    );
  } else if (kind === "noncanonical_content") {
    db.prepare("UPDATE governor_memories SET content_json = ? WHERE memory_id = ?").run(
      `{ "path": "/fixture/noncanonical" }`,
      fixture.replacementId,
    );
  } else if (kind === "malformed_provenance") {
    db.prepare("UPDATE governor_memories SET provenance_json = ? WHERE memory_id = ?").run(
      "{",
      fixture.replacementId,
    );
  } else {
    db.prepare("UPDATE governor_memories SET provenance_json = ? WHERE memory_id = ?").run(
      JSON.stringify(JSON.parse(row.provenance_json), null, 1),
      fixture.replacementId,
    );
  }
}

function assertAccessRejected(harness: MemoryTestHarness, fixture: Fixture, access: Access): void {
  if (access === "recall") {
    expect(
      harness.store.memory
        .retrieve({ scope: memoryScopeA, now: 300 })
        .some((memory) => memory.memoryId === fixture.replacementId),
    ).toBe(false);
    return;
  }
  if (access === "active") {
    expect(
      harness.store.memory.activeReplacement({
        scope: memoryScopeA,
        factKey: fixture.factKey,
        now: 300,
      }),
    ).toBeNull();
    return;
  }
  if (access === "duplicate") {
    expect(
      harness.store.memory.resolveContradiction({
        taskId: fixture.taskId,
        evidenceId: `evidence-canonical-${fixture.factKey.split(".").at(-1)}`,
        staleMemoryId: fixture.staleMemoryId,
        contradictionClass: "stale canonical source",
        executionFence: harness.controller.captureExecutionFence(fixture.taskId),
        now: 300,
      }).kind,
    ).toBe("rejected");
    return;
  }
  const verificationId = `evidence-verification-${fixture.factKey}`;
  persistMemoryEvidence({
    store: harness.store,
    broker: harness.broker,
    taskId: fixture.taskId,
    evidenceId: verificationId,
    criterionId: "repair-verified",
    predicate: governorMemoryRepairPredicate(fixture.factKey),
    value: { path: `/fixture/${fixture.factKey.split(".").at(-1)}/current` },
    observedAt: 300,
  });
  expect(() =>
    harness.store.memory.verifyRepair({
      taskId: fixture.taskId,
      evidenceId: verificationId,
      fingerprint: fixture.remediation.contradictionFingerprint,
      now: 301,
      guard: {
        taskId: fixture.taskId,
        executionFence: harness.controller.captureExecutionFence(fixture.taskId),
        expectedStatus: fixture.remediation.status,
        expectedUpdatedAt: fixture.remediation.updatedAt,
      },
    }),
  ).toThrow("GOVERNOR_MEMORY_REPLACEMENT_NOT_CURRENT");
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor V30 canonical persisted memory binding", () => {
  it.each(TAMPERS.flatMap((kind) => ACCESS_PATHS.map((access) => [kind, access] as const)))(
    "rejects %s tampering through %s",
    async (kind, access) => {
      await withMemoryTestHarness((harness) => {
        const suffix = `${kind}-${access}`;
        const fixture = createFixture(harness, suffix);
        tamper(harness, fixture, kind);
        assertAccessRejected(harness, fixture, access);
      });
    },
  );

  it("retains a quarantined audit marker without returning recomputed forged content", async () => {
    await withMemoryTestHarness((harness) => {
      const fixture = createFixture(harness, "audit-quarantine");
      tamper(harness, fixture, "row_only_rehash");
      expect(harness.store.memory.retrieve({ scope: memoryScopeA, now: 300 })).toEqual([]);
      expect(
        harness.store.memory
          .retrieveAudit({ scope: memoryScopeA })
          .find((memory) => memory.memoryId === fixture.replacementId),
      ).toMatchObject({ status: "quarantined", content: { quarantined: true } });
      expect(
        JSON.stringify(harness.store.memory.retrieveAudit({ scope: memoryScopeA })),
      ).not.toContain("/fixture/row_only_rehash/forged");
    });
  });
});
