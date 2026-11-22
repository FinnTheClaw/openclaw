import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveCronThinkingSelection } from "./model-selection.js";
type SelectionParams = Parameters<typeof resolveCronThinkingSelection>[0];

const scopedThinkingCatalogMock = vi.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
);

vi.mock("./run-model-selection.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: (...args: unknown[]) => scopedThinkingCatalogMock(...args),
  loadResolvedPublishedModelCatalogOwner: () => {
    throw new Error("unexpected full model catalog read in scoped thinking fixture");
  },
}));

beforeEach(() => {
  scopedThinkingCatalogMock.mockReset();
});

const owner: SelectionParams["owner"] = {
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: {},
  modelCatalog: { entries: [], routeVariants: [] },
  metadataSnapshot: createPluginMetadataSnapshotFixture(),
};
const carried = { provider: "openai", id: "gpt-5.6-luna", name: "Selected", reasoning: false };

function selectThinking(
  agentRuntime: string,
  entries: SelectionParams["owner"]["modelCatalog"]["entries"] = [carried],
  jobThinking = "medium",
) {
  return resolveCronThinkingSelection({
    cfg: {},
    owner: { ...owner, modelCatalog: { entries, routeVariants: [] } },
    provider: carried.provider,
    model: carried.id,
    agentRuntime,
    jobThinking,
  });
}

const refreshed = { ...carried, reasoning: true };

it("hydrates unknown host reasoning metadata through the scoped owner", async () => {
  const selected = { provider: carried.provider, id: carried.id, name: carried.name };
  scopedThinkingCatalogMock.mockResolvedValue([refreshed]);

  const selection = await selectThinking("openclaw", [selected]);

  expect(selection).toMatchObject({ catalog: [refreshed], requestedThinkLevel: "medium" });
  expect(scopedThinkingCatalogMock).toHaveBeenCalledOnce();
  expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: selected.provider,
      model: selected.id,
      agentRuntime: "openclaw",
    }),
  );
});

it.each([false, true])(
  "keeps admitted host reasoning metadata when it is %s",
  async (reasoning) => {
    const selected = { ...carried, reasoning };

    const selection = await selectThinking("openclaw", [selected]);

    expect(selection).toMatchObject({ catalog: [selected], requestedThinkLevel: "medium" });
    expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
  },
);

const unrelated = { ...carried, id: "unrelated" };
it.each([
  ["off", [refreshed], [refreshed]],
  ["medium", [], [carried]],
  ["medium", [unrelated], [carried]],
] as const)(
  "selects native thinking=%s with refreshed=%j",
  async (thinking, hydration, expected) => {
    scopedThinkingCatalogMock.mockResolvedValue([...hydration]);
    const selection = await selectThinking("codex", [carried], thinking);
    expect(selection).toMatchObject({
      requestedThinkLevel: thinking,
      catalog: expected,
    });
  },
);

it("keeps the admitted catalog when native hydration outlasts the foreground wait", async () => {
  const held = createDeferred<Array<Record<string, unknown>>>();
  vi.useFakeTimers();
  try {
    scopedThinkingCatalogMock.mockReturnValue(held.promise);
    const pending = selectThinking("codex");
    await vi.advanceTimersByTimeAsync(5_000);
    const selection = await pending;
    expect(selection).toMatchObject({ catalog: [carried], requestedThinkLevel: "medium" });
    held.resolve([refreshed]);
    await expect(
      selection.loadThinkingCatalog(carried.provider, carried.id, "codex"),
    ).resolves.toEqual([refreshed]);
  } finally {
    held.resolve([]);
    vi.useRealTimers();
  }
});
