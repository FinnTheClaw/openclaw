import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authenticateGovernorMemoryFact,
  createGovernorMemoryRetirementDecision,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { GovernorMemoryLanceDbAdapter } from "./governor-memory-adapter.js";
import { governorMemoryFact } from "./governor-memory-fact-fixture.js";
import { HybridMemoryIndex } from "./hybrid-memory-index.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

const KEY = "delayed-expiry-authority-key";
const embeddings = {
  embed: async (text: string) => [text.length + 1, 1, 0, 0],
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length + 1, 1, 0, 0]),
};

function signedFact(overrides: Parameters<typeof governorMemoryFact>[0]) {
  return authenticateGovernorMemoryFact(governorMemoryFact(overrides), KEY);
}

function highWater(pathname: string) {
  const db = new DatabaseSync(pathname);
  try {
    return db
      .prepare(
        "SELECT generation, observed_at, retirement_decision_id, retirement_binding_digest, retirement_reason, authority_key_id FROM memory_governor_high_water WHERE agent_id = 'governor-memory' AND scope = 'scope-a' AND fact_key = 'account.plan'",
      )
      .get() as Record<string, unknown>;
  } finally {
    db.close();
  }
}

export async function delayedExpiryUsesHostDecision(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-retirement-"));
  const ledgerPath = path.join(root, "ledger.sqlite3");
  const indexPath = path.join(root, "lancedb");
  const schema = new TemporalMemoryLedger(ledgerPath);
  schema.close();
  let index = new HybridMemoryIndex(indexPath, 4);
  let adapter = new GovernorMemoryLanceDbAdapter({
    ledgerPath,
    index,
    embeddings,
    authorityBindingKey: KEY,
  });
  try {
    const expiring = signedFact({
      memoryId: "memory-delayed-expiry",
      observedAt: 100,
      freshnessExpiresAt: 120,
      sourceEvidenceId: "evidence-delayed-expiry",
      sourceEvidenceDigest: "digest-delayed-expiry",
    });
    assert.equal((await adapter.admit({ fact: expiring, now: 101 })).status, "admitted");
    const decision = createGovernorMemoryRetirementDecision(
      {
        scopeKey: expiring.scopeKey,
        factKey: expiring.factKey,
        staleMemoryId: expiring.memoryId,
        priorGeneration: 1,
        newGeneration: 2,
        semanticCutoff: 120,
        issuedAt: 1_000,
        reason: "expiry",
        priorAuthorityBindingDigest: expiring.authorityBindingDigest,
      },
      KEY,
    );
    assert.equal((await adapter.retire!(decision)).status, "retired");
    const beforeRestart = highWater(ledgerPath);
    assert.deepEqual(
      { generation: beforeRestart.generation, cutoff: beforeRestart.observed_at },
      { generation: 2, cutoff: 120 },
    );
    const stale = signedFact({
      memoryId: "memory-stale-after-expiry",
      observedAt: 110,
      generation: 3,
      sourceEvidenceId: "evidence-stale-after-expiry",
      sourceEvidenceDigest: "digest-stale-after-expiry",
    });
    assert.equal((await adapter.admit({ fact: stale, now: 1_001 })).status, "rejected");

    adapter.close();
    await index.closeAsync();
    index = new HybridMemoryIndex(indexPath, 4);
    adapter = new GovernorMemoryLanceDbAdapter({
      ledgerPath,
      index,
      embeddings,
      authorityBindingKey: KEY,
    });
    assert.deepEqual(highWater(ledgerPath), beforeRestart);
    assert.equal((await adapter.retire!(decision)).status, "duplicate");
    assert.equal((await adapter.admit({ fact: stale, now: 1_002 })).status, "rejected");
    const current = signedFact({
      memoryId: "memory-after-expiry",
      observedAt: 121,
      generation: 3,
      sourceEvidenceId: "evidence-after-expiry",
      sourceEvidenceDigest: "digest-after-expiry",
      freshnessExpiresAt: 300,
    });
    assert.equal((await adapter.admit({ fact: current, now: 1_003 })).status, "admitted");
  } finally {
    adapter.close();
    await index.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
}
