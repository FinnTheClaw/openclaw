import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMemoryDatabaseRevision } from "./memory/manager-db-kernel.js";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./memory/manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION } from "./memory/manager-reindex-state.js";
import { createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

describe("memory_search retained sync diagnostics", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("keeps newer-index advice after a real failed sync without rewriting the index", async () => {
    testing.resetMemorySearchToolCooldowns();
    const cfg = fixture.createConfig({
      provider: "openai",
      fallback: "none",
      vectorEnabled: false,
    });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const embeddings = await import("./memory/embeddings.js");
    const createProvider = embeddings.createEmbeddingProvider;
    let failSync = false;
    let calls = 0;
    const create = vi
      .spyOn(embeddings, "createEmbeddingProvider")
      .mockImplementation(async (...args) => {
        const result = await createProvider(...args);
        const provider = result.provider;
        if (!provider) {
          throw new Error("fixture embedding provider missing");
        }
        return {
          ...result,
          provider: {
            ...provider,
            embedBatch: async (inputs) => {
              calls += 1;
              if (failSync) {
                throw Object.assign(
                  new Error("HTTP 400: synthetic embedding provider unavailable"),
                  { status: 400 },
                );
              }
              return await provider.embedBatch(inputs);
            },
          },
        };
      });
    try {
      const manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "cli", force: true });
      failSync = true;
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("HTTP 400");
      expect(manager.status().lastSyncError).toContain("HTTP 400");
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(
        "UPDATE memory_index_meta SET value = json_set(value, '$.provenanceVersion', ?) WHERE key = 'memory_index_meta_v1'",
      ).run(MEMORY_INDEX_PROVENANCE_VERSION + 1);
      const before = readMemoryDatabaseRevision(db);
      const chunks = db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
      const priorCalls = calls;
      const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      const result = await tool.execute("newer-after-sync-failure", {
        query: "alpha",
        corpus: "memory",
      });
      expect(result.details).toMatchObject({
        results: [],
        unavailable: true,
        error: expect.stringContaining("newer OpenClaw"),
        warning: expect.stringContaining("Previous memory sync failed: HTTP 400"),
        action: expect.stringContaining("upgrade OpenClaw or reindex explicitly"),
      });
      expect(manager.status().lastSyncError).toContain("HTTP 400");
      expect(readMemoryDatabaseRevision(db)).toBe(before);
      expect(db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(chunks);
      expect(calls).toBe(priorCalls);
      expect(fixture.provider.embedQueryCalls).toBe(0);
    } finally {
      create.mockRestore();
    }
  });

  it.each([
    { name: "retains a memory-file failure across targeted session success", failMemory: true },
    { name: "leaves healthy targeted session success unwarned", failMemory: false },
  ])("L08-F003 $name", async ({ failMemory }) => {
    testing.resetMemorySearchToolCooldowns();
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      vectorEnabled: false,
      minScore: 0,
    });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const sessionId = failMemory ? "retained-memory-failure" : "healthy-targeted-session";
    const sessionKey = "agent:main:chat:" + sessionId;
    const sessionPath = "sessions/main/" + sessionId + ".jsonl";
    await fixture.seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [
        {
          role: "user",
          timestamp: 1,
          content: "Published violet preference.",
          senderIsOwner: true,
        },
      ],
    });
    const manager = await fixture.getFreshManager(cfg);
    const fields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      sessionsFullRetryDirty: boolean;
      memoryWatcherReady: Promise<void>;
      settings: { sync: { onSearch: boolean; onSessionStart: boolean; watch: boolean } };
      closeWatchResources: () => Promise<void>;
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
      syncArchiveFiles: (params: {
        needsFullReindex: boolean;
        targetArchiveFiles?: string[];
      }) => Promise<unknown>;
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };
    // Sync switches are resolved defaults, not public config knobs. Silence only
    // this owned manager's watch/search triggers; explicit sync remains real.
    await fields.memoryWatcherReady;
    await fields.closeWatchResources();
    fields.settings.sync.onSearch = false;
    fields.settings.sync.onSessionStart = false;
    fields.settings.sync.watch = false;
    await manager.sync({ reason: "baseline", force: true });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const baselineSession = readPublishedSessionIndex(db, sessionPath, "violet");
    const baselineStatus = manager.status();
    const memorySync = vi.spyOn(fields, "syncMemoryFiles");
    const sessionSync = vi.spyOn(fields, "syncArchiveFiles");
    const backgroundSync = vi.spyOn(fields, "syncPublishedIndexInBackground");
    const search = vi.spyOn(manager, "search");
    const sourceFailure = new Error("synthetic memory-file discovery failure");
    const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    try {
      let failedError: unknown;
      if (failMemory) {
        memorySync.mockRejectedValueOnce(sourceFailure);
        fields.dirty = true;
        failedError = await manager.sync({ reason: "memory-file-change" }).then(
          () => undefined,
          (error: unknown) => error,
        );
      }
      const failedStatus = manager.status();
      const fullRetryBeforeTarget = {
        memory: fields.memoryFullRetryDirty,
        sessions: fields.sessionsFullRetryDirty,
      };
      const beforeTarget = await tool.execute("L08-F003-before-target", {
        query: "zebra",
        corpus: "memory",
      });
      const memoryCallsBeforeTarget = memorySync.mock.calls.length;
      sessionSync.mockClear();
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [
          {
            role: "user",
            timestamp: 2,
            content: "New violet response after publication.",
            senderIsOwner: true,
          },
        ],
      });
      await manager.sync({
        reason: "targeted-session",
        sessions: [{ agentId: "main", sessionId, sessionKey }],
      });
      const targetedSession = readPublishedSessionIndex(db, sessionPath, "violet");
      const targetedStatus = manager.status();
      const targetedSessionCalls = [...sessionSync.mock.calls];
      const memoryCallsAfterTarget = memorySync.mock.calls.length;
      const afterTarget = await tool.execute("L08-F003-after-target", {
        query: "zebra",
        corpus: "memory",
      });
      let recoveredStatus: ReturnType<typeof manager.status> | undefined;
      let recoveredDetails: unknown;
      if (failMemory) {
        await manager.sync({ reason: "ordinary-memory-recovery" });
        recoveredStatus = manager.status();
        recoveredDetails = (
          await tool.execute("L08-F003-after-recovery", { query: "zebra", corpus: "memory" })
        ).details;
      }

      // Joint observations include admission, actual targeted writes and public
      // diagnostics before any downstream oracle can stop the case.
      expect(baselineStatus.lastSyncError).toBeUndefined();
      expect(baselineSession.source).toBeDefined();
      expect(fullRetryBeforeTarget).toEqual({ memory: false, sessions: false });
      expect(targetedSessionCalls).toEqual([
        [
          expect.objectContaining({
            needsFullReindex: false,
            targetArchiveFiles: [sessionKey],
            corpusEntries: [
              expect.objectContaining({
                agentId: "main",
                sessionId,
                sessionKey,
                transcriptSource: "sqlite",
              }),
            ],
          }),
        ],
      ]);
      expect(targetedSession.source?.hash).not.toBe(baselineSession.source?.hash);
      expect(targetedSession.chunks.map((chunk) => chunk.text).join("\n")).toContain(
        "New violet response after publication.",
      );
      expect(memoryCallsAfterTarget).toBe(memoryCallsBeforeTarget);
      expect(backgroundSync).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledTimes(failMemory ? 3 : 2);
      expect(beforeTarget.details).toMatchObject({
        results: expect.arrayContaining([
          expect.objectContaining({ path: "memory/2026-01-12.md" }),
        ]),
      });
      expect(afterTarget.details).toMatchObject({
        results: expect.arrayContaining([
          expect.objectContaining({ path: "memory/2026-01-12.md" }),
        ]),
      });
      if (failMemory) {
        expect(failedError).toBe(sourceFailure);
        expect(memoryCallsBeforeTarget).toBe(1);
        expect(failedStatus).toMatchObject({
          dirty: true,
          lastSyncError: sourceFailure.message,
        });
        expect(beforeTarget.details).toMatchObject({
          stale: true,
          warning: expect.stringContaining(sourceFailure.message),
          action: expect.stringContaining("openclaw memory status --index --agent main"),
        });
        expect(targetedStatus).toMatchObject({
          dirty: true,
          lastSyncError: sourceFailure.message,
        });
        expect(afterTarget.details).toMatchObject({
          stale: true,
          warning: expect.stringContaining(sourceFailure.message),
          action: expect.stringContaining("openclaw memory status --index --agent main"),
        });
        expect(memorySync).toHaveBeenCalledTimes(2);
        expect(recoveredStatus).toMatchObject({ dirty: false, lastSyncError: undefined });
        expect(recoveredDetails).not.toHaveProperty("stale");
        expect(recoveredDetails).not.toHaveProperty("warning");
      } else {
        expect(memoryCallsBeforeTarget).toBe(0);
        expect(targetedStatus).toMatchObject({ dirty: false, lastSyncError: undefined });
        expect(beforeTarget.details).not.toHaveProperty("stale");
        expect(afterTarget.details).not.toHaveProperty("stale");
        expect(afterTarget.details).not.toHaveProperty("warning");
      }
    } finally {
      search.mockRestore();
      backgroundSync.mockRestore();
      sessionSync.mockRestore();
      memorySync.mockRestore();
    }
  });
});
