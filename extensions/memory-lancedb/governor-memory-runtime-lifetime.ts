import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DurableMemoryRuntime } from "./durable-memory-runtime.js";
import { governorMemoryFact } from "./governor-memory-fact-fixture.js";

let embeddingCalls = 0;
const embedding = {
  embed: async (text: string) => {
    embeddingCalls += 1;
    return [text.length + 1, 1, 0, 0];
  },
  embedBatch: async (texts: string[]) => {
    embeddingCalls += texts.length;
    return texts.map((text) => [text.length + 1, 1, 0, 0]);
  },
};

function fact(id: string, observedAt: number, replacement = false) {
  const object = replacement ? "premium" : "standard";
  return governorMemoryFact({
    memoryId: id,
    object,
    text: `The account uses the ${replacement ? "premium" : "standard"} plan.`,
    content: { object },
    observedAt,
    sourceIdentity: id,
    sourceEvidenceId: `evidence-${id}`,
    sourceEvidenceDigest: `digest-${id}`,
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c07-runtime-lifetime-"));
const runtime = new DurableMemoryRuntime({
  ledgerPath: path.join(root, "ledger.sqlite3"),
  projectionPath: path.join(root, "lancedb"),
  vectorDimensions: 4,
  embeddings: embedding,
  logger: {},
});
const backend = runtime.createGovernorMemoryBackend({
  mode: "enforce",
  refreshDerived: async () => {
    await runtime.flush(20_000);
  },
});

try {
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const first = fact(`standard-${iteration}`, 100 + iteration * 1_000);
    const replacement = fact(`premium-${iteration}`, 200 + iteration * 1_000, true);
    await backend.admit({ fact: first, now: first.observedAt + 1 });
    await backend.invalidate({
      agentId: first.agentId,
      scope: first.scope,
      factKey: first.factKey,
      staleMemoryId: first.memoryId,
      sourceEvidenceId: replacement.sourceEvidenceId,
      sourceEvidenceDigest: replacement.sourceEvidenceDigest,
      sourceObservedAt: replacement.observedAt,
      reason: "contradicted_by_newer_evidence",
      replacement,
      now: replacement.observedAt + 1,
    });
    const recalled = await backend.recall({
      agentId: first.agentId,
      scopes: [first.scope],
      query: "account plan",
      limit: 5,
      now: replacement.observedAt + 2,
    });
    assert.deepEqual(
      recalled.map((item) => item.memoryId),
      [replacement.memoryId],
    );
    await backend.compact({ agentId: first.agentId, now: 100_000, retentionMs: 1 });
  }
  assert.ok(embeddingCalls > 0);
  assert.equal(runtime.ledger.getStats().pendingProjection, 0);
  assert.ok((await runtime.index.getStats()).rows > 0);
} finally {
  backend.close?.();
  await runtime.stop();
}

const reopened = new DurableMemoryRuntime({
  ledgerPath: path.join(root, "ledger.sqlite3"),
  projectionPath: path.join(root, "lancedb"),
  vectorDimensions: 4,
  embeddings: embedding,
  logger: {},
});
const reopenedBackend = reopened.createGovernorMemoryBackend({ mode: "enforce" });
try {
  const recalled = await reopenedBackend.recall({
    agentId: "agent-a",
    scopes: ["scope-a"],
    query: "account plan",
    limit: 20,
    now: 100_000,
  });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0]?.memoryId, "premium-15");
} finally {
  reopenedBackend.close?.();
  await reopened.stop();
  assert.equal(fs.existsSync(path.join(root, "ledger.sqlite3-wal")), false);
  assert.equal(fs.existsSync(path.join(root, "ledger.sqlite3-shm")), false);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
