// Covers one-shot session hint persistence against missing persisted rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applySessionHints } from "./body.js";

async function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-hints-"));
  try {
    return await run(path.join(dir, "sessions.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applySessionHints", () => {
  it("recreates a complete persisted row when clearing a consumed abort hint", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:explicit:hint-missing-row";
      const entry: SessionEntry = {
        sessionId: "hint-session",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        abortedLastRun: true,
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      await fs.writeFile(storePath, JSON.stringify({}, null, 2), "utf8");

      const body = await applySessionHints({
        baseBody: "continue",
        abortedLastRun: true,
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(body).toContain("previous run was explicitly stopped and is closed");
      expect(body).toContain("current user message as a fresh authoritative request");
      expect(sessionStore[sessionKey]?.sessionId).toBe("hint-session");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("openai");
      expect(sessionStore[sessionKey]?.abortedLastRun).toBe(false);
      expect(persisted?.sessionId).toBe("hint-session");
      expect(persisted?.modelProvider).toBe("openai");
      expect(persisted?.model).toBe("gpt-5.5");
      expect(persisted?.abortedLastRun).toBe(false);
    });
  });

  it("closes a failed prior run instead of inviting stale task resumption", async () => {
    const body = await applySessionHints({
      baseBody: "hey",
      abortedLastRun: false,
      previousRunStatus: "failed",
    });

    expect(body).toContain("previous run ended without a valid final answer and is closed");
    expect(body).toContain("Do not resume prior work");
    expect(body).toMatch(/\n\nhey$/);
  });

  it("closes an orphaned running turn before handling a fresh message", async () => {
    const body = await applySessionHints({
      baseBody: "hey",
      abortedLastRun: false,
      previousRunStatus: "running",
      previousRunWasOrphaned: true,
    });

    expect(body).toContain("left marked running without an active owner and is closed");
    expect(body).toContain("Do not resume prior work");
    expect(body).toMatch(/\n\nhey$/);
  });
});
