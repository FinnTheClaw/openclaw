import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GovernorMemoryLanceDbAdapter } from "./governor-memory-adapter.js";
import { governorMemoryFact } from "./governor-memory-fact-fixture.js";
import { GovernorMemoryLedger } from "./governor-memory-ledger.js";
import { HybridMemoryIndex } from "./hybrid-memory-index.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

const embeddings = {
  embed: async (text: string) => [text.length + 1, 1, 0, 0],
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length + 1, 1, 0, 0]),
};

function createRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c07-review-"));
}

function prepareLedger(root: string): string {
  const ledgerPath = path.join(root, "ledger.sqlite3");
  const temporal = new TemporalMemoryLedger(ledgerPath);
  temporal.close();
  return ledgerPath;
}

function openAdapter(ledgerPath: string) {
  const index = new HybridMemoryIndex(path.join(path.dirname(ledgerPath), "lancedb"), 4);
  return {
    index,
    adapter: new GovernorMemoryLanceDbAdapter({ ledgerPath, index, embeddings }),
  };
}

async function retirementFencesRecallAfterRestart(): Promise<void> {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const opened = openAdapter(ledgerPath);
  try {
    const fact = governorMemoryFact();
    assert.equal((await opened.adapter.admit({ fact, now: 101 })).status, "admitted");
    await opened.adapter.retire!({
      agentId: "governor",
      scope: fact.scope,
      scopeKey: fact.scopeKey,
      factKey: fact.factKey,
      staleMemoryId: fact.memoryId,
      reason: "operator_requested",
      now: 200,
    });
    assert.deepEqual(
      await opened.adapter.recall({
        agentId: "governor",
        scopes: [fact.scopeKey],
        scopeKeys: [fact.scopeKey],
        query: "account plan",
        limit: 5,
        now: 201,
      }),
      [],
    );
  } finally {
    opened.adapter.close();
    await opened.index.closeAsync();
  }
  const reopened = openAdapter(ledgerPath);
  try {
    assert.deepEqual(
      await reopened.adapter.recall({
        agentId: "governor",
        scopes: ["scope-a"],
        scopeKeys: ["scope-a"],
        query: "account plan",
        limit: 5,
        now: 300,
      }),
      [],
    );
  } finally {
    reopened.adapter.close();
    await reopened.index.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lineageOverflowRollsBack(): void {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const ledger = new GovernorMemoryLedger(ledgerPath);
  try {
    const rootFact = governorMemoryFact({
      memoryId: "lineage-root",
      factKey: "lineage.root",
      sourceEvidenceId: "lineage-root-evidence",
      sourceEvidenceDigest: "lineage-root-digest",
      observedAt: 100,
    });
    ledger.admit(rootFact, 101);
    for (let index = 0; index < 257; index += 1) {
      ledger.admit(
        governorMemoryFact({
          memoryId: `lineage-child-${index}`,
          factKey: `lineage.child.${index}`,
          sourceEvidenceId: `lineage-child-evidence-${index}`,
          sourceEvidenceDigest: `lineage-child-digest-${index}`,
          observedAt: 200 + index,
          sourceMemoryLineage: [rootFact.memoryId],
        }),
        300 + index,
      );
    }
    assert.throws(
      () =>
        ledger.invalidate({
          agentId: "governor-memory",
          scopeKey: rootFact.scopeKey,
          factKey: rootFact.factKey,
          staleMemoryId: rootFact.memoryId,
          sourceEvidenceId: "lineage-new-evidence",
          sourceEvidenceDigest: "lineage-new-digest",
          sourceObservedAt: 10_000,
          reason: "contradicted_by_newer_evidence",
          now: 10_001,
        }),
      /GOVERNOR_MEMORY_LINEAGE_TOO_LARGE/u,
    );
    assert.equal(
      ledger.current("governor-memory", rootFact.scopeKey, rootFact.factKey)?.memoryId,
      rootFact.memoryId,
    );
    assert.equal(
      ledger.current("governor-memory", rootFact.scopeKey, "lineage.child.256")?.memoryId,
      "lineage-child-256",
    );
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function highWaterSurvivesCompaction(): void {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const ledger = new GovernorMemoryLedger(ledgerPath);
  try {
    const original = governorMemoryFact({ observedAt: 100 });
    ledger.admit(original, 101);
    ledger.invalidate({
      agentId: "governor-memory",
      scopeKey: original.scopeKey,
      factKey: original.factKey,
      staleMemoryId: original.memoryId,
      sourceEvidenceId: "new-evidence",
      sourceEvidenceDigest: "new-digest",
      sourceObservedAt: 200,
      reason: "contradicted_by_newer_evidence",
      now: 201,
    });
    ledger.compact({ agentId: "governor-memory", now: 100_000, retentionMs: 1 });
    assert.equal(
      ledger.admit(
        governorMemoryFact({
          memoryId: "old-replay",
          observedAt: 150,
          sourceEvidenceId: "old-replay-evidence",
          sourceEvidenceDigest: "old-replay-digest",
        }),
        100_001,
      ).status,
      "rejected",
    );
    assert.equal(
      ledger.highWater("governor-memory", original.scopeKey, original.factKey)?.status,
      "tombstone",
    );
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function persistedBindingTamperIsRejected(): Promise<void> {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const ledger = new GovernorMemoryLedger(ledgerPath);
  const original = governorMemoryFact();
  ledger.admit(original, 101);
  ledger.close();
  const db = new DatabaseSync(ledgerPath);
  db.prepare(
    "UPDATE memory_fact_revisions SET metadata_json = json_set(metadata_json, '$.governor.scopeEpoch', 99) WHERE revision_id = ?",
  ).run(original.memoryId);
  db.close();
  const reopened = new GovernorMemoryLedger(ledgerPath);
  try {
    assert.equal(
      reopened.current("governor-memory", original.scopeKey, original.factKey),
      undefined,
    );
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await retirementFencesRecallAfterRestart();
lineageOverflowRollsBack();
highWaterSurvivesCompaction();
await persistedBindingTamperIsRejected();
