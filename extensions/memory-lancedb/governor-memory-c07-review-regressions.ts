import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authenticateGovernorMemoryFact,
  createGovernorMemoryRetirementDecision,
  governorMemoryAuthorityBindingDigest,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
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

function openAdapter(ledgerPath: string, authorityBindingKey?: string) {
  const index = new HybridMemoryIndex(path.join(path.dirname(ledgerPath), "lancedb"), 4);
  return {
    index,
    adapter: new GovernorMemoryLanceDbAdapter({
      ledgerPath,
      index,
      embeddings,
      authorityBindingKey,
    }),
  };
}

async function retirementFencesRecallAfterRestart(): Promise<void> {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const authorityBindingKey = "retirement-fence-fixture-key";
  const opened = openAdapter(ledgerPath, authorityBindingKey);
  try {
    const fact = authenticateGovernorMemoryFact(governorMemoryFact(), authorityBindingKey);
    assert.equal((await opened.adapter.admit({ fact, now: 101 })).status, "admitted");
    await opened.adapter.retire!(
      createGovernorMemoryRetirementDecision(
        {
          scopeKey: fact.scopeKey,
          factKey: fact.factKey,
          staleMemoryId: fact.memoryId,
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 200,
          issuedAt: 200,
          reason: "explicit_forget",
          priorAuthorityBindingDigest: fact.authorityBindingDigest,
        },
        authorityBindingKey,
      ),
    );
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
  const reopened = openAdapter(ledgerPath, authorityBindingKey);
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
          sourceEvidenceLineage: [rootFact.sourceEvidenceId],
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

function keyedBindingRejectsTamper(): void {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const ledger = new GovernorMemoryLedger(ledgerPath, { authorityBindingKey: "fixture-key" });
  try {
    const signed = authenticateGovernorMemoryFact(governorMemoryFact(), "fixture-key");
    assert.equal(ledger.admit(signed, 101).status, "admitted");
    const forged = {
      ...signed,
      authority: signed.authority + 0.01,
      authorityBindingDigest: governorMemoryAuthorityBindingDigest({
        ...signed,
        authority: signed.authority + 0.01,
      }),
    };
    assert.throws(() => ledger.admit(forged, 102), /authority MAC is invalid/u);
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function everyBindingFieldIsFenced(): void {
  const mutations: readonly [string, (fact: ReturnType<typeof governorMemoryFact>) => unknown][] = [
    ["authority", (fact) => fact.authority + 0.01],
    ["generation", (fact) => fact.generation + 1],
    ["sourceEvidenceId", () => "tampered-evidence"],
    ["sourceEvidenceLineage", () => ["tampered-lineage"]],
    ["sourceMemoryLineage", () => ["tampered-memory"]],
  ];
  for (const [field, value] of mutations) {
    const root = createRoot();
    const ledgerPath = prepareLedger(root);
    const ledger = new GovernorMemoryLedger(ledgerPath);
    const original = governorMemoryFact();
    assert.equal(ledger.admit(original, 101).status, "admitted");
    ledger.close();
    const db = new DatabaseSync(ledgerPath);
    const row = db
      .prepare("SELECT metadata_json FROM memory_fact_revisions WHERE revision_id = ?")
      .get(original.memoryId) as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as { governor: Record<string, unknown> };
    metadata.governor[field] = value(original);
    db.prepare("UPDATE memory_fact_revisions SET metadata_json = ? WHERE revision_id = ?").run(
      JSON.stringify(metadata),
      original.memoryId,
    );
    if (field === "authority") {
      db.prepare("UPDATE memory_fact_revisions SET authority = ? WHERE revision_id = ?").run(
        Number(metadata.governor.authority),
        original.memoryId,
      );
    }
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
}

function expiryAdvancesReplayHighWater(): void {
  const root = createRoot();
  const ledgerPath = prepareLedger(root);
  const ledger = new GovernorMemoryLedger(ledgerPath);
  try {
    const expiring = governorMemoryFact({ freshnessExpiresAt: 120 });
    assert.equal(ledger.admit(expiring, 101).status, "admitted");
    ledger.compact({ agentId: "governor-memory", now: 200, retentionMs: 1 });
    assert.equal(
      ledger.admit(
        governorMemoryFact({
          memoryId: "pre-expiry-replay",
          observedAt: 110,
          generation: 2,
          sourceEvidenceId: "pre-expiry-evidence",
          sourceEvidenceDigest: "pre-expiry-digest",
          freshnessExpiresAt: 130,
        }),
        201,
      ).status,
      "rejected",
    );
    assert.equal(
      ledger.highWater("governor-memory", expiring.scopeKey, expiring.factKey)?.status,
      "tombstone",
    );
    assert.equal(
      ledger.admit(
        governorMemoryFact({
          memoryId: "post-expiry-reobservation",
          observedAt: 210,
          generation: 3,
          sourceEvidenceId: "post-expiry-evidence",
          sourceEvidenceDigest: "post-expiry-digest",
          freshnessExpiresAt: 300,
        }),
        211,
      ).status,
      "admitted",
    );
    assert.equal(
      ledger.highWater("governor-memory", expiring.scopeKey, expiring.factKey)?.status,
      "active",
    );
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await retirementFencesRecallAfterRestart();
lineageOverflowRollsBack();
highWaterSurvivesCompaction();
await persistedBindingTamperIsRejected();
keyedBindingRejectsTamper();
everyBindingFieldIsFenced();
expiryAdvancesReplayHighWater();
