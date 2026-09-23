// Focused ten-case SQLite trajectory retry pack for the production runtime recorder.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

const tempDirs = createTempDirTracker();
let storePath: string;
let dbPath: string;
const sessionId = "retry-session";
const sessionKey = "agent:main:retry";

async function types(session = sessionId): Promise<string[]> {
  return (await loadSqliteTrajectoryRuntimeEvents({ sessionId: session, storePath })).map(
    (event) => event.type,
  );
}

function recorder(session = sessionId, key = sessionKey) {
  const value = createTrajectoryRuntimeRecorder({
    env: { OPENCLAW_TRAJECTORY: "1" },
    sessionId: session,
    sessionKey: key,
    sessionTarget: { agentId: "main", sessionId: session, sessionKey: key, storePath },
  });
  if (!value) {
    throw new Error("expected a SQLite trajectory recorder");
  }
  return value;
}

function database() {
  return openOpenClawAgentDatabase({ agentId: "main", path: dbPath }).db;
}

function failInsert(when = "1") {
  database().exec(
    `CREATE TRIGGER reject_trajectory BEFORE INSERT ON trajectory_runtime_events
     WHEN ${when} BEGIN SELECT RAISE(ABORT, 'controlled-insert-failure'); END`,
  );
}

function allowInsert() {
  database().exec("DROP TRIGGER IF EXISTS reject_trajectory");
}

describe("trajectory SQLite flush retry (ten named cases)", () => {
  beforeEach(async () => {
    const tempDir = tempDirs.make("trajectory-flush-retry-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    dbPath = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it("T01 first-row trigger failure retains and retries once", async () => {
    const sink = recorder();
    sink.recordEvent("first");
    failInsert();
    await expect(sink.flush()).rejects.toThrow("controlled-insert-failure");
    expect(sink.describeFlushState()).toContain("pendingRows=1");
    allowInsert();
    await sink.flush();
    expect(await types()).toEqual(["first"]);
  });

  it("T02 second-row failure rolls back both and retries in order", async () => {
    const sink = recorder();
    sink.recordEvent("first");
    sink.recordEvent("second");
    failInsert("NEW.seq = 1");
    await expect(sink.flush()).rejects.toThrow("controlled-insert-failure");
    expect(await types()).toEqual([]);
    expect(sink.describeFlushState()).toContain("pendingRows=2");
    allowInsert();
    await sink.flush();
    expect(await types()).toEqual(["first", "second"]);
  });

  it("T03 busy write lock retains the event for an unlocked retry", async () => {
    const sink = recorder();
    sink.recordEvent("locked");
    const second = new DatabaseSync(dbPath);
    try {
      second.exec("BEGIN IMMEDIATE");
      await expect(sink.flush()).rejects.toThrow();
      expect(sink.describeFlushState()).toContain("pendingRows=1");
    } finally {
      second.exec("ROLLBACK");
      second.close();
    }
    await sink.flush();
    expect(await types()).toEqual(["locked"]);
  });

  it("T04 query-only SQLite failure retains and retries", async () => {
    const sink = recorder();
    sink.recordEvent("query-only");
    database().exec("PRAGMA query_only = ON");
    await expect(sink.flush()).rejects.toThrow();
    expect(sink.describeFlushState()).toContain("pendingRows=1");
    database().exec("PRAGMA query_only = OFF");
    await sink.flush();
    expect(await types()).toEqual(["query-only"]);
  });

  it("T05 existing durable row survives failed append", async () => {
    const sink = recorder();
    sink.recordEvent("existing");
    await sink.flush();
    sink.recordEvent("new");
    failInsert();
    await expect(sink.flush()).rejects.toThrow();
    expect(await types()).toEqual(["existing"]);
    allowInsert();
    await sink.flush();
    expect(await types()).toEqual(["existing", "new"]);
  });

  it("T06 event added after a failed flush preserves order", async () => {
    const sink = recorder();
    sink.recordEvent("old");
    failInsert();
    await expect(sink.flush()).rejects.toThrow();
    sink.recordEvent("later");
    expect(sink.describeFlushState()).toContain("pendingRows=2");
    allowInsert();
    await sink.flush();
    expect(await types()).toEqual(["old", "later"]);
  });

  it("T07 two failures preserve the same queued count and bytes", async () => {
    const sink = recorder();
    sink.recordEvent("twice");
    const state = sink.describeFlushState();
    failInsert();
    await expect(sink.flush()).rejects.toThrow();
    expect(sink.describeFlushState()).toBe(state);
    await expect(sink.flush()).rejects.toThrow();
    expect(sink.describeFlushState()).toBe(state);
    allowInsert();
    await sink.flush();
    expect(await types()).toEqual(["twice"]);
  });

  it("T08 successful retry makes the next flush a no-op", async () => {
    const sink = recorder();
    sink.recordEvent("once");
    failInsert();
    await expect(sink.flush()).rejects.toThrow();
    allowInsert();
    await sink.flush();
    expect(sink.describeFlushState()).toBeUndefined();
    await sink.flush();
    expect(await types()).toEqual(["once"]);
  });

  it("T09 failed session retry does not mutate a neighboring session", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:neighbor", storePath },
      { sessionId: "neighbor", updatedAt: 1 },
    );
    const other = recorder("neighbor", "agent:main:neighbor");
    other.recordEvent("neighbor-event");
    await other.flush();
    const sink = recorder();
    sink.recordEvent("retry-event");
    failInsert("NEW.session_id = 'retry-session'");
    await expect(sink.flush()).rejects.toThrow();
    allowInsert();
    await sink.flush();
    expect(await types("neighbor")).toEqual(["neighbor-event"]);
    expect(await types()).toEqual(["retry-event"]);
  });

  it("T10 adjacent file writer still flushes normally", async () => {
    const writes: string[] = [];
    let flushed = 0;
    const sink = createTrajectoryRuntimeRecorder({
      sessionId,
      writer: {
        filePath: path.join(path.dirname(storePath), "trajectory.jsonl"),
        write: (line) => writes.push(line),
        flush: async () => {
          flushed += 1;
        },
      },
    });
    if (!sink) {
      throw new Error("expected file writer recorder");
    }
    sink.recordEvent("file-event");
    await sink.flush();
    expect(writes).toHaveLength(1);
    expect(flushed).toBe(1);
    expect(await types()).toEqual([]);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
