import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableMemoryRuntime } from "./durable-memory-runtime.js";
import { GovernorMemoryLanceDbAdapter } from "./governor-memory-adapter.js";
import { GovernorMemoryLedger } from "./governor-memory-ledger.js";
import { HybridMemoryIndex } from "./hybrid-memory-index.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

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

const compareStrings = (left: string, right: string): number => left.localeCompare(right);

function fact(
  overrides: Partial<Parameters<GovernorMemoryLanceDbAdapter["admit"]>[0]["fact"]> = {},
) {
  return {
    memoryId: "memory-a",
    agentId: "agent-a",
    scope: "scope-a",
    factKey: "account.plan",
    subject: "account",
    predicate: "plan",
    object: "standard",
    text: "The account uses the standard plan.",
    category: "fact",
    confidence: 0.95,
    authority: 0.9,
    observedAt: 100,
    sourceIdentity: "host-evidence-a",
    sourceEvidenceId: "evidence-a",
    sourceEvidenceDigest: "digest-a",
    ...overrides,
  } as const;
}

type Context = {
  root: string;
  ledgerPath: string;
  indexPath: string;
  index: HybridMemoryIndex;
  adapter: GovernorMemoryLanceDbAdapter;
};

function createContext(): Context {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c07-memory-"));
  const ledgerPath = path.join(root, "ledger.sqlite3");
  const indexPath = path.join(root, "lancedb");
  const schema = new TemporalMemoryLedger(ledgerPath);
  schema.close();
  const index = new HybridMemoryIndex(indexPath, 4);
  return {
    root,
    ledgerPath,
    indexPath,
    index,
    adapter: new GovernorMemoryLanceDbAdapter({ ledgerPath, index, embeddings: embedding }),
  };
}

async function closeContext(context: Context): Promise<void> {
  context.adapter.close();
  await context.index.closeAsync();
  await assert.rejects(context.index.has("memory-a"), /memory index is closed/u);
  fs.rmSync(context.root, { recursive: true, force: true });
  assert.equal(fs.existsSync(context.root), false);
}

async function writesAndScopes(): Promise<void> {
  const context = createContext();
  try {
    assert.equal((await context.adapter.admit({ fact: fact(), now: 110 })).status, "admitted");
    assert.equal(
      (
        await context.adapter.admit({
          fact: fact({
            memoryId: "memory-b",
            scope: "scope-b",
            sourceEvidenceId: "evidence-b",
            sourceEvidenceDigest: "digest-b",
          }),
          now: 120,
        })
      ).status,
      "admitted",
    );
    const scopeA = await context.adapter.recall({
      agentId: "agent-a",
      scopes: ["scope-a"],
      query: "account plan",
      limit: 5,
      now: 130,
    });
    const scopeB = await context.adapter.recall({
      agentId: "agent-a",
      scopes: ["scope-b"],
      query: "account plan",
      limit: 5,
      now: 130,
    });
    assert.deepEqual(
      scopeA.map((item) => item.memoryId),
      ["memory-a"],
    );
    assert.deepEqual(
      scopeB.map((item) => item.memoryId),
      ["memory-b"],
    );
  } finally {
    await closeContext(context);
  }
}

async function runtimeShadow(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c07-runtime-"));
  const runtime = new DurableMemoryRuntime({
    ledgerPath: path.join(root, "ledger.sqlite3"),
    projectionPath: path.join(root, "lancedb"),
    vectorDimensions: 4,
    embeddings: embedding,
    logger: {},
  });
  try {
    const shadow = runtime.createGovernorMemoryBackend({ mode: "shadow" });
    assert.deepEqual(
      await shadow.recall({
        agentId: "agent-a",
        scopes: ["scope-a"],
        query: "account",
        limit: 5,
        now: 100,
      }),
      [],
    );
    assert.equal((await shadow.admit({ fact: fact(), now: 100 })).status, "rejected");
    const db = new DatabaseSync(path.join(root, "ledger.sqlite3"));
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_governor_high_water'",
        )
        .get(),
      undefined,
    );
    db.close();
  } finally {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
}

async function replacementAndLineage(): Promise<void> {
  const context = createContext();
  try {
    await context.adapter.admit({ fact: fact(), now: 110 });
    const replacement = fact({
      memoryId: "memory-b",
      object: "premium",
      text: "The account uses the premium plan.",
      observedAt: 200,
      sourceIdentity: "host-evidence-b",
      sourceEvidenceId: "evidence-b",
      sourceEvidenceDigest: "digest-b",
    });
    const invalidation = await context.adapter.invalidate({
      agentId: "agent-a",
      scope: "scope-a",
      factKey: "account.plan",
      staleMemoryId: "memory-a",
      sourceEvidenceId: "evidence-b",
      sourceEvidenceDigest: "digest-b",
      sourceObservedAt: 200,
      reason: "contradicted_by_newer_evidence",
      replacement,
      now: 210,
    });
    assert.equal(invalidation.status, "retired");
    const ledger = new GovernorMemoryLedger(context.ledgerPath);
    assert.equal(ledger.current("agent-a", "scope-a", "account.plan")?.generation, 2);
    ledger.close();
    assert.equal(
      (
        await context.adapter.recall({
          agentId: "agent-a",
          scopes: ["scope-a"],
          query: "account plan",
          limit: 5,
          now: 220,
        })
      )[0]?.memoryId,
      "memory-b",
    );
    assert.equal(
      (
        await context.adapter.invalidate({
          agentId: "agent-a",
          scope: "scope-a",
          factKey: "account.plan",
          staleMemoryId: "memory-a",
          sourceEvidenceId: "evidence-b",
          sourceEvidenceDigest: "digest-b",
          sourceObservedAt: 200,
          reason: "contradicted_by_newer_evidence",
          replacement,
          now: 220,
        })
      ).status,
      "duplicate",
    );
  } finally {
    await closeContext(context);
  }
}

async function transitiveLineage(): Promise<void> {
  const context = createContext();
  try {
    await context.adapter.admit({ fact: fact(), now: 110 });
    await context.adapter.admit({
      fact: fact({
        memoryId: "memory-summary",
        factKey: "account.summary",
        text: "The account summary depends on the standard plan.",
        sourceIdentity: "derived-summary",
        sourceEvidenceId: "evidence-summary",
        sourceEvidenceDigest: "digest-summary",
        sourceEvidenceLineage: ["evidence-a"],
        sourceMemoryLineage: ["memory-a"],
      }),
      now: 120,
    });
    await context.adapter.admit({
      fact: fact({
        memoryId: "memory-report",
        factKey: "account.report",
        text: "The account report depends on the summary.",
        sourceIdentity: "derived-report",
        sourceEvidenceId: "evidence-report",
        sourceEvidenceDigest: "digest-report",
        sourceMemoryLineage: ["memory-summary"],
      }),
      now: 121,
    });
    await context.adapter.admit({
      fact: fact({
        memoryId: "memory-independent",
        factKey: "account.owner",
        text: "The account owner is a verified user.",
        sourceIdentity: "independent-source",
        sourceEvidenceId: "evidence-a",
        sourceEvidenceDigest: "digest-independent",
      }),
      now: 125,
    });
    const replacement = fact({
      memoryId: "memory-a-new",
      object: "premium",
      text: "The account uses the premium plan.",
      observedAt: 200,
      sourceIdentity: "host-evidence-b",
      sourceEvidenceId: "evidence-b",
      sourceEvidenceDigest: "digest-b",
    });
    const result = await context.adapter.invalidate({
      agentId: "agent-a",
      scope: "scope-a",
      factKey: "account.plan",
      staleMemoryId: "memory-a",
      sourceEvidenceId: "evidence-b",
      sourceEvidenceDigest: "digest-b",
      sourceObservedAt: 200,
      reason: "contradicted_by_newer_evidence",
      replacement,
      now: 210,
    });
    assert.deepEqual(
      result.invalidatedMemoryIds.toSorted(compareStrings),
      ["memory-a", "memory-summary", "memory-report"].toSorted(compareStrings),
    );
    const recalled = await context.adapter.recall({
      agentId: "agent-a",
      scopes: ["scope-a"],
      query: "account",
      limit: 10,
      now: 220,
    });
    assert.deepEqual(
      recalled.map((item) => item.memoryId).toSorted(compareStrings),
      ["memory-a-new", "memory-independent"].toSorted(compareStrings),
    );
  } finally {
    await closeContext(context);
  }
}

async function staleProjectionAndRestart(): Promise<void> {
  const context = createContext();
  await context.adapter.admit({ fact: fact(), now: 110 });
  const originalDelete = context.index.delete.bind(context.index);
  let fail = true;
  context.index.delete = async (id: string) => {
    if (fail) {
      fail = false;
      throw new Error("projection temporarily unavailable");
    }
    return await originalDelete(id);
  };
  await assert.rejects(
    context.adapter.invalidate({
      agentId: "agent-a",
      scope: "scope-a",
      factKey: "account.plan",
      staleMemoryId: "memory-a",
      sourceEvidenceId: "evidence-x",
      sourceEvidenceDigest: "digest-x",
      sourceObservedAt: 200,
      reason: "freshness_expired",
      now: 210,
    }),
    /projection temporarily unavailable/u,
  );
  context.adapter.close();
  await context.index.closeAsync();
  const index = new HybridMemoryIndex(context.indexPath, 4);
  const adapter = new GovernorMemoryLanceDbAdapter({
    ledgerPath: context.ledgerPath,
    index,
    embeddings: embedding,
  });
  try {
    assert.deepEqual(
      await adapter.recall({
        agentId: "agent-a",
        scopes: ["scope-a"],
        query: "account plan",
        limit: 5,
        now: 220,
      }),
      [],
    );
  } finally {
    adapter.close();
    await index.closeAsync();
    fs.rmSync(context.root, { recursive: true, force: true });
    assert.equal(fs.existsSync(context.root), false);
  }
}

async function poisoningAndCompaction(): Promise<void> {
  const context = createContext();
  try {
    await assert.rejects(
      context.adapter.admit({ fact: fact({ text: "api_key=sk-secret-value" }), now: 110 }),
      /memory content was rejected/u,
    );
    await context.adapter.admit({ fact: fact(), now: 110 });
    await context.adapter.invalidate({
      agentId: "agent-a",
      scope: "scope-a",
      factKey: "account.plan",
      staleMemoryId: "memory-a",
      sourceEvidenceId: "evidence-x",
      sourceEvidenceDigest: "digest-x",
      sourceObservedAt: 200,
      reason: "operator_requested",
      now: 210,
    });
    assert.equal(
      (await context.adapter.compact({ agentId: "agent-a", now: 100_000, retentionMs: 60_000 }))
        .compacted,
      1,
    );
    const ledger = new GovernorMemoryLedger(context.ledgerPath);
    assert.equal(ledger.highWater("agent-a", "scope-a", "account.plan")?.status, "tombstone");
    ledger.close();
    const db = new DatabaseSync(context.ledgerPath);
    try {
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM memory_fact_revisions WHERE revision_id = 'memory-a'",
            )
            .get() as { count: number }
        ).count,
        0,
      );
      assert.equal(
        (
          db.prepare("SELECT COUNT(*) AS count FROM memory_governor_remediations").get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM memory_events WHERE content LIKE '%standard plan%'",
            )
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await closeContext(context);
  }
}

await writesAndScopes();
await runtimeShadow();
await replacementAndLineage();
await transitiveLineage();
await staleProjectionAndRestart();
await poisoningAndCompaction();
