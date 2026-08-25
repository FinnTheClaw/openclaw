import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "./runtime.js";

const { resolveProviders } = vi.hoisted(() => ({
  resolveProviders: vi.fn<() => PluginWebSearchProviderEntry[]>(),
}));

vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: () => undefined,
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: () => resolveProviders(),
  resolveRuntimeWebSearchProviders: () => resolveProviders(),
}));

function providerReturning(result: unknown): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "boundary-search",
    id: "boundary",
    credentialPath: "",
    requiresCredential: false,
    createTool: () => ({
      description: "boundary",
      parameters: {},
      execute: async () => result as Record<string, unknown>,
    }),
  });
}

async function execute(result: unknown) {
  resolveProviders.mockReturnValue([providerReturning(result)]);
  return runWebSearch({
    config: { tools: { web: { search: { provider: "boundary" } } } },
    preferInputConfig: true,
    args: { query: "boundary" },
  });
}

describe("web search provider result boundary", () => {
  beforeEach(() => {
    resolveProviders.mockReset();
  });

  it("snapshots accessor output exactly once before inspecting it", async () => {
    let reads = 0;
    const result = Object.defineProperty({}, "error", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("provider output was read twice");
        }
        return "invalid_freshness";
      },
    });

    await expect(execute(result)).resolves.toEqual({
      provider: "boundary",
      result: { error: "invalid_freshness" },
    });
    expect(reads).toBe(1);
  });

  it.each([
    ["null", null],
    ["string", "hostile"],
    ["number", 42],
    ["array", []],
    ["non-record object", new Date(0)],
    [
      "throwing proxy",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("hostile");
          },
        },
      ),
    ],
  ])(
    "returns a fixed provider error for a non-record or hostile payload: %s",
    async (_name, result) => {
      await expect(execute(result)).resolves.toEqual({
        provider: "boundary",
        result: { error: "provider_error" },
      });
    },
  );
});
