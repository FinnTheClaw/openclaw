// Covers abort-cutoff clearing against missing persisted rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readAbortCutoffFromSessionEntry, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { clearAbortCutoffInSessionRuntime } from "./abort-cutoff.runtime.js";

async function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-cutoff-"));
  try {
    return await run(path.join(dir, "sessions.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("clearAbortCutoffInSessionRuntime", () => {
  it.each(["newer persisted", "replacement generation", "newer memory", "matching"] as const)(
    "observed cutoff ownership: %s",
    async (kind) => {
      await withTempStore(async (storePath) => {
        const sessionKey = "agent:main:explicit:cutoff-owned";
        const otherKey = "agent:main:explicit:cutoff-unrelated";
        const entry: SessionEntry = {
          sessionId: "captured-session",
          updatedAt: 1,
          modelProvider: "synthetic-provider",
          model: "synthetic-model",
          abortCutoffMessageSid: "100",
          abortCutoffTimestamp: 1000,
        };
        const observedCutoff = readAbortCutoffFromSessionEntry(entry)!;
        const observedSessionId = entry.sessionId;
        const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
        const scope = { storePath, sessionKey };
        await patchSessionEntryCore(scope, () => entry, { fallbackEntry: entry });
        const unrelated: SessionEntry = {
          sessionId: "unrelated-session",
          updatedAt: 7,
          abortCutoffMessageSid: "999",
          abortCutoffTimestamp: 9990,
        };
        await patchSessionEntryCore({ storePath, sessionKey: otherKey }, () => unrelated, {
          fallbackEntry: unrelated,
        });
        if (kind === "newer persisted") {
          await patchSessionEntryCore(scope, () => ({
            abortCutoffMessageSid: "200",
            abortCutoffTimestamp: 2000,
            updatedAt: 2,
          }));
        } else if (kind === "replacement generation") {
          await patchSessionEntryCore(
            scope,
            () => ({
              sessionId: "replacement-session",
              updatedAt: 2,
              abortCutoffMessageSid: "100",
              abortCutoffTimestamp: 1000,
            }),
            { replaceEntry: true },
          );
        } else if (kind === "newer memory") {
          entry.abortCutoffMessageSid = "200";
          entry.abortCutoffTimestamp = 2000;
          entry.updatedAt = 2;
        }
        const memoryBefore = structuredClone(entry);
        const persistedBefore = loadSessionEntry(scope);
        const otherBefore = loadSessionEntry({ storePath, sessionKey: otherKey });
        const args = {
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath: kind === "newer memory" ? undefined : storePath,
          observedCutoff,
          observedSessionId,
        };
        const cleared = await clearAbortCutoffInSessionRuntime(args);
        const persisted = loadSessionEntry(scope);
        expect(loadSessionEntry({ storePath, sessionKey: otherKey })).toEqual(otherBefore);
        if (kind === "matching") {
          expect(cleared).toBe(true);
          expect(entry.abortCutoffMessageSid).toBeUndefined();
          expect(entry.abortCutoffTimestamp).toBeUndefined();
          expect(persisted?.abortCutoffMessageSid).toBeUndefined();
          expect(persisted?.abortCutoffTimestamp).toBeUndefined();
          expect(entry.sessionId).toBe("captured-session");
          expect(persisted?.sessionId).toBe("captured-session");
          expect(entry.model).toBe("synthetic-model");
          expect(persisted?.modelProvider).toBe("synthetic-provider");
          expect(
            shouldSkipMessageByAbortCutoff({
              cutoffMessageSid: persisted?.abortCutoffMessageSid,
              cutoffTimestamp: persisted?.abortCutoffTimestamp,
              messageSid: "100",
              timestamp: 1000,
            }),
          ).toBe(false);
        } else {
          expect(persisted).toEqual(persistedBefore);
          expect(entry).toEqual(memoryBefore);
          expect(sessionStore[sessionKey]).toBe(entry);
          expect(cleared).toBe(false);
          const retained = kind === "newer memory" ? entry : persisted;
          expect(
            shouldSkipMessageByAbortCutoff({
              cutoffMessageSid: retained?.abortCutoffMessageSid,
              cutoffTimestamp: retained?.abortCutoffTimestamp,
              messageSid: kind === "replacement generation" ? "100" : "200",
              timestamp: kind === "replacement generation" ? 1000 : 2000,
            }),
          ).toBe(true);
        }
        expect(observedCutoff).toEqual({ messageSid: "100", timestamp: 1000 });
        expect(observedSessionId).toBe("captured-session");
      });
    },
  );

  it("recreates a complete persisted row when clearing abort cutoff state", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:explicit:cutoff-missing-row";
      const entry: SessionEntry = {
        sessionId: "cutoff-session",
        updatedAt: 1,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        abortCutoffMessageSid: "msg-42",
        abortCutoffTimestamp: 123,
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      const cleared = await clearAbortCutoffInSessionRuntime({
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath,
      });

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(cleared).toBe(true);
      expect(sessionStore[sessionKey]?.sessionId).toBe("cutoff-session");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.abortCutoffMessageSid).toBeUndefined();
      expect(sessionStore[sessionKey]?.abortCutoffTimestamp).toBeUndefined();
      expect(persisted?.sessionId).toBe("cutoff-session");
      expect(persisted?.modelProvider).toBe("anthropic");
      expect(persisted?.model).toBe("claude-opus-4-6");
      expect(persisted?.abortCutoffMessageSid).toBeUndefined();
      expect(persisted?.abortCutoffTimestamp).toBeUndefined();
    });
  });
});
