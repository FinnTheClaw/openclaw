import { expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryIndexManager } from "./manager.js";

it("keeps synchronous PostgreSQL status on the published index during a rebuild", async () => {
  const admission = { engine: "postgres", hasIndex: true, ftsAvailable: true } as const;
  const owner = (readOnly: boolean) =>
    new MemoryIndexDatabase(undefined, undefined, readOnly, undefined, true, admission);
  const published = owner(true);
  published.facts = {
    ...published.facts,
    hasIndexedChunks: true,
    hasSemanticChunks: true,
    hasVectorTable: true,
    vectorState: { state: "complete" },
  };
  const staged = owner(false);
  staged.postgresStageId = "test-rebuild";
  // Neither owner opens a connection. Only the private stage begins with empty facts.
  using openPublished = vi.spyOn(MemoryIndexDatabase, "openPublished").mockResolvedValue(published);
  const manager = await MemoryIndexManager.get({
    cfg: { memory: { search: { provider: "none" } } },
    agentId: "main",
    purpose: "status",
  });
  if (!manager) {
    throw new Error("Expected the fake published status owner");
  }

  // Enter the real async rebuild context without running a reindex.
  const harness = manager as unknown as {
    withReindexDatabase<T>(database: MemoryIndexDatabase, run: () => Promise<T>): Promise<T>;
  };
  try {
    expect(openPublished).toHaveBeenCalledOnce();
    expect(staged.facts.vectorState).toEqual({ state: "empty" });
    expect(manager.status().vector?.index).toEqual({ state: "complete" });

    await harness.withReindexDatabase(staged, async () => {
      expect((await manager.statusAsync({ includeCounts: false })).vector?.index).toEqual({
        state: "complete",
      });
      expect(manager.status().vector?.index).toEqual({ state: "complete" });
    });
  } finally {
    await manager.close();
  }
});
