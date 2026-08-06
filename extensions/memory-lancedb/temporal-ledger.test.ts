import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

describe("TemporalMemoryLedger", () => {
  let tmpDir = "";
  let ledger: TemporalMemoryLedger | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-ledger-"));
  });

  afterEach(async () => {
    ledger?.close();
    ledger = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function open(): TemporalMemoryLedger {
    ledger = new TemporalMemoryLedger(path.join(tmpDir, "ledger.sqlite3"));
    return ledger;
  }

  it("durably appends events and idempotently reconciles stable external IDs", () => {
    const db = open();
    const first = db.appendEvent({
      agentId: "jake",
      sessionKey: "signal:family",
      channel: "signal",
      conversationId: "family",
      role: "user",
      content: "The generator maintenance window is Thursday at 09:00.",
      sourceKind: "message_received",
      externalId: "signal-message-42",
      observedAt: 1_000,
    });
    const replay = db.appendEvent({
      agentId: "jake",
      sessionKey: "signal:family",
      channel: "signal",
      conversationId: "family",
      role: "user",
      content: "The generator maintenance window is Thursday at 09:00.",
      sourceKind: "message_received",
      externalId: "signal-message-42",
      observedAt: 1_000,
    });

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect(db.getStats()).toMatchObject({ events: 1, pendingProjection: 1 });
  });

  it("recovers an expired projection lease without losing or duplicating the source event", () => {
    const db = open();
    const stored = db.appendEvent({
      agentId: "jake",
      role: "assistant",
      content: "I completed the UPS battery replacement.",
      sourceKind: "before_message_write",
      externalId: "assistant-message-7",
      observedAt: 5_000,
    }).event;

    const first = db.claimProjectionBatch({
      owner: "worker-a",
      limit: 10,
      leaseMs: 1_000,
      now: 5_000,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.eventId).toBe(stored.eventId);
    expect(db.claimProjectionBatch({ owner: "worker-b", limit: 10, now: 5_500 })).toHaveLength(0);

    const recovered = db.claimProjectionBatch({ owner: "worker-b", limit: 10, now: 6_001 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attempts).toBe(2);
    expect(db.markProjected(stored.eventId, "worker-a")).toBe(false);
    expect(db.markProjected(stored.eventId, "worker-b")).toBe(true);
    expect(db.getStats()).toMatchObject({ events: 1, pendingProjection: 0, leasedProjection: 0 });
  });

  it("retries projection failures and retains poison events in a dead-letter state", () => {
    const db = open();
    const event = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "Remember the rack PDU is on circuit C.",
      sourceKind: "message_received",
      externalId: "message-pdu",
    }).event;
    db.claimProjectionBatch({ owner: "worker", limit: 1, now: 10_000 });
    expect(
      db.markProjectionFailed({
        eventId: event.eventId,
        owner: "worker",
        error: "embedding endpoint unavailable",
        retryDelayMs: 5_000,
        maxAttempts: 2,
        now: 10_001,
      }),
    ).toBe("retry");
    expect(db.claimProjectionBatch({ owner: "worker", limit: 1, now: 14_999 })).toHaveLength(0);
    expect(db.claimProjectionBatch({ owner: "worker", limit: 1, now: 15_001 })).toHaveLength(1);
    expect(
      db.markProjectionFailed({
        eventId: event.eventId,
        owner: "worker",
        error: "malformed vector",
        maxAttempts: 2,
        now: 15_002,
      }),
    ).toBe("dead");
    expect(db.getStats()).toMatchObject({ events: 1, deadProjection: 1 });
  });

  it("atomically requeues selected dead-letter work without deleting source events", () => {
    const db = open();
    const event = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The greenhouse controller is named Juniper.",
      sourceKind: "message_received",
      externalId: "dead-letter-recovery",
    }).event;

    db.claimProjectionBatch({ owner: "projection-worker", limit: 1, now: 10_000 });
    expect(
      db.markProjectionFailed({
        eventId: event.eventId,
        owner: "projection-worker",
        error: "invalid embedding",
        maxAttempts: 1,
        now: 10_001,
      }),
    ).toBe("dead");
    db.claimFactExtractionBatch({ owner: "extraction-worker", limit: 1, now: 10_000 });
    expect(
      db.markFactExtractionFailed({
        eventId: event.eventId,
        owner: "extraction-worker",
        error: "generation unavailable",
        maxAttempts: 1,
        now: 10_001,
      }),
    ).toBe("dead");
    expect(db.getStats()).toMatchObject({
      events: 1,
      deadProjection: 1,
      deadExtraction: 1,
    });

    expect(db.requeueDeadLetters({ queue: "projection", now: 20_000 })).toEqual({
      queue: "projection",
      projection: 1,
      extraction: 0,
      total: 1,
      recoveredAt: 20_000,
    });
    expect(db.getStats()).toMatchObject({
      events: 1,
      pendingProjection: 1,
      deadProjection: 0,
      deadExtraction: 1,
    });
    expect(
      db.claimProjectionBatch({ owner: "projection-recovery", limit: 1, now: 20_001 }),
    ).toEqual([expect.objectContaining({ eventId: event.eventId, attempts: 1 })]);

    expect(db.requeueDeadLetters({ queue: "extraction", now: 21_000 })).toEqual({
      queue: "extraction",
      projection: 0,
      extraction: 1,
      total: 1,
      recoveredAt: 21_000,
    });
    expect(
      db.claimFactExtractionBatch({
        owner: "extraction-recovery",
        limit: 1,
        now: 21_001,
      }),
    ).toEqual([expect.objectContaining({ eventId: event.eventId, attempts: 1 })]);

    expect(db.requeueDeadLetters({ queue: "all", now: 22_000 })).toEqual({
      queue: "all",
      projection: 0,
      extraction: 0,
      total: 0,
      recoveredAt: 22_000,
    });
    expect(db.getStats()).toMatchObject({ events: 1 });
  });

  it("preserves temporal fact revisions while exposing only the latest active value", () => {
    const db = open();
    const oldEvidence = db.appendEvent({
      agentId: "finn",
      role: "user",
      content: "Narya has two inference slots.",
      sourceKind: "message_received",
      externalId: "slots-old",
      observedAt: 20_000,
    }).event;
    const oldFact = db.appendFactRevision({
      agentId: "finn",
      subject: "Narya",
      predicate: "inference_slot_count",
      object: "2",
      text: "Narya has two inference slots.",
      sourceEventId: oldEvidence.eventId,
      observedAt: 20_000,
      confidence: 0.95,
      authority: 0.9,
    });
    const duplicateEvidence = db.appendEvent({
      agentId: "finn",
      role: "assistant",
      content: "Confirmed: Narya has two inference slots.",
      sourceKind: "before_message_write",
      externalId: "slots-confirmation",
      observedAt: 21_000,
    }).event;
    const duplicate = db.appendFactRevision({
      factKey: oldFact.fact.factKey,
      agentId: "finn",
      subject: "Narya",
      predicate: "inference_slot_count",
      object: "2",
      text: "Narya has two inference slots.",
      sourceEventId: duplicateEvidence.eventId,
      observedAt: 21_000,
    });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.fact.revisionId).toBe(oldFact.fact.revisionId);

    const newEvidence = db.appendEvent({
      agentId: "finn",
      role: "user",
      content: "Narya now has three equally divided inference slots.",
      sourceKind: "message_received",
      externalId: "slots-new",
      observedAt: 30_000,
    }).event;
    const newFact = db.appendFactRevision({
      factKey: oldFact.fact.factKey,
      agentId: "finn",
      subject: "Narya",
      predicate: "inference_slot_count",
      object: "3",
      text: "Narya has three equally divided inference slots.",
      sourceEventId: newEvidence.eventId,
      observedAt: 30_000,
      confidence: 0.99,
      authority: 1,
    });

    expect(newFact.fact.supersedesRevisionId).toBe(oldFact.fact.revisionId);
    expect(
      db.findCurrentFacts({ agentId: "finn", subject: "Narya", predicate: "inference_slot_count" }),
    ).toEqual([expect.objectContaining({ object: "3", status: "active" })]);
    expect(db.getStats()).toMatchObject({ factRevisions: 2, activeFacts: 1 });
  });

  it("cryptographically-neutralizes explicit deletions and blocks transcript resurrection", () => {
    const db = open();
    const original = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "This personal memory must be forgotten.",
      sourceKind: "message_received",
      externalId: "private-message-1",
    });
    expect(db.deleteEvent(original.event.eventId)).toBe(true);
    expect(db.getStats()).toMatchObject({ events: 1, pendingProjection: 0 });

    const replay = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "This personal memory must be forgotten.",
      sourceKind: "transcript_reconcile",
      externalId: "private-message-1",
    });
    expect(replay.inserted).toBe(false);
    expect(replay.event.content).toBe("");
    expect(db.getStats()).toMatchObject({ events: 1, pendingProjection: 0 });
  });

  it("does not impose a count-based retention ceiling", () => {
    const db = open();
    db.appendEvents(
      Array.from({ length: 5_000 }, (_, index) => ({
        agentId: "jake",
        role: "user" as const,
        content: `Synthetic durable fact ${index}: value-${index}.`,
        sourceKind: "load_test",
        externalId: `fact-${index}`,
        observedAt: 100_000 + index,
      })),
    );
    expect(db.getStats()).toMatchObject({ events: 5_000, pendingProjection: 5_000 });
  }, 30_000);

  it("creates a transactionally consistent integrity-checked snapshot", () => {
    const db = open();
    db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The snapshot must retain this fact.",
      sourceKind: "message_received",
      externalId: "snapshot-fact",
    });
    expect(db.verifyIntegrity()).toEqual({ ok: true, messages: ["ok"] });
    const snapshotPath = path.join(tmpDir, "snapshots", "ledger.sqlite3");
    db.createSnapshot(snapshotPath);
    const snapshot = new TemporalMemoryLedger(snapshotPath);
    try {
      expect(snapshot.verifyIntegrity()).toEqual({ ok: true, messages: ["ok"] });
      expect(snapshot.getStats()).toMatchObject({ events: 1 });
    } finally {
      snapshot.close();
    }
  });

  it("migrates an existing v1 summary table in place without dropping content", () => {
    const ledgerPath = path.join(tmpDir, "ledger.sqlite3");
    const legacy = new DatabaseSync(ledgerPath);
    legacy.exec(`
      CREATE TABLE memory_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO memory_metadata(key, value) VALUES('schema_version', '1');
      CREATE TABLE memory_summary_nodes (
        node_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('day', 'week', 'month', 'year')),
        bucket_start INTEGER NOT NULL,
        bucket_end INTEGER NOT NULL,
        summary_text TEXT NOT NULL DEFAULT '',
        source_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0, 1)),
        updated_at INTEGER NOT NULL,
        UNIQUE(agent_id, scope, level, bucket_start)
      ) STRICT;
      INSERT INTO memory_summary_nodes(
        node_id, agent_id, scope, level, bucket_start, bucket_end,
        summary_text, source_count, dirty, updated_at
      ) VALUES('legacy-day', 'jake', 'global', 'day', 0, 86400000,
        'Legacy summary remains durable.', 7, 1, 1234);
    `);
    legacy.close();

    ledger = new TemporalMemoryLedger(ledgerPath);
    expect(ledger.verifyIntegrity()).toEqual({ ok: true, messages: ["ok"] });
    expect(ledger.getSummaryNode("legacy-day")).toMatchObject({
      summaryText: "Legacy summary remains durable.",
      sourceCount: 7,
      sourceGeneration: 0,
      summarizedGeneration: 0,
      targetGeneration: 0,
      attempts: 0,
    });
    expect(ledger.claimSummaryBatch({ owner: "migration-test", limit: 1 })).toHaveLength(1);
  });

  it("leases fact extraction independently from durable capture", () => {
    const db = open();
    const event = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "The greenhouse controller is named Juniper.",
      sourceKind: "message_received",
      externalId: "greenhouse-controller",
      observedAt: 1_787_000_000_000,
    }).event;
    db.appendEvent({
      agentId: "jake",
      role: "tool",
      content: "command completed",
      sourceKind: "before_message_write",
      externalId: "tool-result",
    });

    expect(db.getStats()).toMatchObject({ pendingExtraction: 1 });
    const leased = db.claimFactExtractionBatch({ owner: "extractor-a", limit: 10 });
    expect(leased).toEqual([
      expect.objectContaining({ eventId: event.eventId, leaseOwner: "extractor-a" }),
    ]);
    expect(db.markFactExtractionCompleted(event.eventId, "extractor-b")).toBe(false);
    expect(db.markFactExtractionCompleted(event.eventId, "extractor-a")).toBe(true);
    expect(db.getStats()).toMatchObject({ pendingExtraction: 0 });
  });

  it("refreshes only dirty temporal-summary paths without losing concurrent facts", () => {
    const db = open();
    const observedAt = Date.UTC(2026, 7, 5, 12);
    const firstEvent = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "Juniper controls greenhouse irrigation.",
      sourceKind: "message_received",
      externalId: "summary-fact-1",
      observedAt,
    }).event;
    db.appendFactRevision({
      agentId: "jake",
      subject: "Juniper",
      predicate: "controls",
      object: "greenhouse irrigation",
      text: "Juniper controls greenhouse irrigation.",
      sourceEventId: firstEvent.eventId,
      observedAt,
      authority: 1,
    });

    expect(db.getStats()).toMatchObject({ dirtySummaries: 4, pendingMaterialization: 1 });
    const [day] = db.claimSummaryBatch({ owner: "summary-a", limit: 1 });
    expect(day).toMatchObject({ level: "day", targetGeneration: 1 });
    expect(db.getSummarySources(day!)).toEqual(["Juniper controls greenhouse irrigation."]);

    const secondEvent = db.appendEvent({
      agentId: "jake",
      role: "user",
      content: "Juniper uses circuit C.",
      sourceKind: "message_received",
      externalId: "summary-fact-2",
      observedAt: observedAt + 1_000,
    }).event;
    db.appendFactRevision({
      agentId: "jake",
      subject: "Juniper",
      predicate: "power_circuit",
      object: "C",
      text: "Juniper uses circuit C.",
      sourceEventId: secondEvent.eventId,
      observedAt: observedAt + 1_000,
    });

    expect(
      db.completeSummary({
        nodeId: day!.nodeId,
        owner: "summary-a",
        targetGeneration: day!.targetGeneration,
        summaryText: "Juniper controls greenhouse irrigation.",
      }),
    ).toBe(true);
    expect(db.getSummaryNode(day!.nodeId)).toMatchObject({
      sourceGeneration: 2,
      summarizedGeneration: 1,
    });
    const [refreshedDay] = db.claimSummaryBatch({ owner: "summary-b", limit: 1 });
    expect(refreshedDay).toMatchObject({ nodeId: day!.nodeId, targetGeneration: 2 });
  });

  it("materializes both superseded and current fact revisions for temporal filtering", () => {
    const db = open();
    const oldEvent = db.appendEvent({
      agentId: "finn",
      role: "user",
      content: "Narya has two slots.",
      sourceKind: "message_received",
      externalId: "material-old",
    }).event;
    const oldFact = db.appendFactRevision({
      agentId: "finn",
      subject: "Narya",
      predicate: "slot_count",
      object: "2",
      text: "Narya has two slots.",
      sourceEventId: oldEvent.eventId,
    }).fact;
    const newEvent = db.appendEvent({
      agentId: "finn",
      role: "user",
      content: "Narya now has three slots.",
      sourceKind: "message_received",
      externalId: "material-new",
    }).event;
    const newFact = db.appendFactRevision({
      agentId: "finn",
      subject: "Narya",
      predicate: "slot_count",
      object: "3",
      text: "Narya now has three slots.",
      sourceEventId: newEvent.eventId,
    }).fact;

    const leases = db.claimMaterializationBatch({ owner: "indexer", limit: 10 });
    expect(leases.map((lease) => lease.recordId).toSorted()).toEqual(
      [oldFact.revisionId, newFact.revisionId].toSorted(),
    );
    expect(
      leases
        .map((lease) => db.getMaterializationRecord(lease))
        .map((record) => (record && "status" in record ? record.status : undefined)),
    ).toEqual(expect.arrayContaining(["superseded", "active"]));
    for (const lease of leases) {
      expect(db.markMaterialized(lease)).toBe(true);
    }
    expect(db.getStats()).toMatchObject({ pendingMaterialization: 0 });
  });

  it("tracks an unbounded set of source checkpoints without a monolithic registry", () => {
    const db = open();
    for (let index = 0; index < 300; index++) {
      db.upsertSourceCheckpoint({
        sourceKind: "workspace_memory_markdown",
        agentId: index % 2 === 0 ? "finn" : "jake",
        workspaceDir: "/workspace",
        sourcePath: `/workspace/memory/note-${index}.md`,
        sourceIdentity: `dev:inode-${index}`,
        sizeBytes: 100 + index,
        mtimeMs: 1_000 + index,
        contentSha256: `sha-${index}`,
        eventIds: [`event-${index}-a`, `event-${index}-b`],
        updatedAt: 2_000 + index,
      });
    }

    expect(db.listSourceCheckpoints({ sourceKind: "workspace_memory_markdown" })).toHaveLength(300);
    expect(
      db.getSourceCheckpoint({
        sourceKind: "workspace_memory_markdown",
        agentId: "jake",
        sourcePath: "/workspace/memory/note-299.md",
      }),
    ).toMatchObject({
      sourceIdentity: "dev:inode-299",
      contentSha256: "sha-299",
      eventIds: ["event-299-a", "event-299-b"],
    });
    expect(
      db.deleteSourceCheckpoint({
        sourceKind: "workspace_memory_markdown",
        agentId: "jake",
        sourcePath: "/workspace/memory/note-299.md",
      }),
    ).toBe(true);
    expect(
      db.listSourceCheckpoints({
        sourceKind: "workspace_memory_markdown",
        agentId: "jake",
      }),
    ).toHaveLength(149);
  });
});
