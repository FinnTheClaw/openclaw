import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, expect, it, vi } from "vitest";
import { executeMemorySearchToolQuery } from "./memory-search-tool-query.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";

vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

it.each([false, true])(
  "keeps a pending keyword snapshot only if it was not reset (reset: %s)",
  async (reset) => {
    const hit: MemorySearchResult = {
      path: "memory/ordinary.md",
      source: "memory",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "Ordinary keyword match",
    };
    const filtering = createDeferred<MemorySearchResult[]>();
    const filteringEntered = createDeferred<void>();
    const finishSearch = createDeferred<MemorySearchResult[]>();
    let clearPartial = () => {};
    const manager: MemorySearchManager = {
      search: async (_query, options) => {
        clearPartial = () => options?.onPartialResults?.(null);
        options?.onPartialResults?.([hit]);
        return await finishSearch.promise;
      },
      status: () => ({ backend: "builtin", provider: "fixture" }),
      readFile: async () => ({ status: "not_found", path: "", text: "" }),
      probeEmbeddingAvailability: async () => ({ ok: true }),
      probeVectorAvailability: async () => false,
    };
    vi.mocked(filterMemorySearchHitsBySessionVisibility)
      .mockImplementationOnce(() => {
        filteringEntered.resolve();
        return filtering.promise;
      })
      .mockResolvedValue([]);
    const snapshots = vi.fn();
    const query = executeMemorySearchToolQuery({
      initialManager: { manager },
      query: { text: "keyword", resultLimit: 1, defaultSources: ["memory"] },
      visibility: { cfg: {}, agentId: "main", sandboxed: false },
      signal: new AbortController().signal,
      onPartialResults: snapshots,
    });
    try {
      await filteringEntered.promise;
      expect(snapshots.mock.calls).toEqual([[null]]);
      if (reset) {
        clearPartial();
        expect(snapshots.mock.calls).toEqual([[null], [null]]);
      }
      filtering.resolve([hit]);
      await filtering.promise;
      await Promise.resolve();
      const published = snapshots.mock.calls.map(([result]) => result).filter(Boolean);
      expect(published).toMatchObject(reset ? [] : [{ rawResults: [hit] }]);
    } finally {
      filtering.resolve([]);
      finishSearch.resolve([]);
      await query;
    }
  },
);

it.each(["abort", "session"] as const)("withholds keyword snapshots for %s", async (event) => {
  const hit: MemorySearchResult = {
    path: "memory/visible.md",
    source: event === "session" ? "sessions" : "memory",
    startLine: 1,
    endLine: 1,
    score: 1,
    snippet: "Visible keyword match",
  };
  const filtering = createDeferred<MemorySearchResult[]>();
  const finishSearch = createDeferred<MemorySearchResult[]>();
  const searchEntered = createDeferred<void>();
  const manager: MemorySearchManager = {
    search: async (_query, options) => {
      options?.onPartialResults?.([hit]);
      searchEntered.resolve();
      return await finishSearch.promise;
    },
    status: () => ({ backend: "builtin", provider: "fixture" }),
    readFile: async () => ({ status: "not_found", path: "", text: "" }),
    probeEmbeddingAvailability: async () => ({ ok: true }),
    probeVectorAvailability: async () => false,
  };
  vi.mocked(filterMemorySearchHitsBySessionVisibility)
    .mockImplementationOnce(() => filtering.promise)
    .mockResolvedValue([]);
  const caller = new AbortController();
  const snapshots = vi.fn();
  const query = executeMemorySearchToolQuery({
    initialManager: { manager },
    query: { text: "keyword", resultLimit: 1, defaultSources: ["memory"] },
    visibility: { cfg: {}, agentId: "main", sandboxed: false },
    signal: caller.signal,
    onPartialResults: snapshots,
  });
  try {
    await searchEntered.promise;
    expect(filterMemorySearchHitsBySessionVisibility).toHaveBeenCalledTimes(
      event === "session" ? 0 : 1,
    );
    expect(snapshots).toHaveBeenCalledWith(null);
    if (event === "abort") {
      caller.abort(new Error("caller cancelled"));
    }
    filtering.resolve([hit]);
    await filtering.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots.mock.calls.every(([result]) => result === null)).toBe(true);
  } finally {
    filtering.resolve([]);
    finishSearch.resolve([]);
    await query;
  }
});
