import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { DurableMemoryRuntime } from "./durable-memory-runtime.js";

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

function digest(...values: unknown[]): string {
  return createHash("sha256")
    .update(
      values
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join("\u0000"),
    )
    .digest("hex");
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fact(id: string, observedAt: number, replacement = false): MemoryGovernorFact {
  const scopeKey = "scope-a";
  const object = replacement ? "premium" : "standard";
  const content = { object };
  const sourceEvidenceId = `evidence-${id}`;
  const sourceEvidenceDigest = `digest-${id}`;
  const sourceEvidenceSemanticDigest = `semantic-${sourceEvidenceDigest}`;
  return {
    memoryId: id,
    agentId: "agent-a",
    scope: "scope-a",
    scopeKey,
    scopeEpoch: 0,
    factKey: "account.plan",
    subject: "account",
    predicate: "plan",
    object,
    text: `The account uses the ${replacement ? "premium" : "standard"} plan.`,
    content,
    contentDigest: jsonDigest(content),
    status: "verified",
    sourceKind: "structured_external",
    sourceRank: 600,
    generation: 1,
    confidence: 0.95,
    authority: 0.9,
    observedAt,
    sourceIdentity: id,
    sourceEvidenceId,
    sourceEvidenceDigest,
    sourceEvidenceSemanticDigest,
    authorityBindingDigest: digest(
      "authority",
      scopeKey,
      "account.plan",
      sourceEvidenceId,
      sourceEvidenceDigest,
      sourceEvidenceSemanticDigest,
    ),
    provenance: {
      sourceRef: id,
      observedAt,
      recordedAt: observedAt,
      scopeKey,
      confidence: 0.95,
      sensitivity: "normal",
    },
  };
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
