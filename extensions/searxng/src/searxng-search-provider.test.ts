// Searxng tests cover searxng search provider plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSearxngBaseUrl,
  resolveSearxngCategories,
  resolveSearxngLanguage,
} from "./config.js";

const { runSearxngSearch } = vi.hoisted(() => ({
  runSearxngSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./searxng-client.js", () => ({
  runSearxngSearch,
}));

function buildSearxngConfig(
  baseUrl: unknown,
  secrets?: {
    providers?: Record<string, unknown>;
    defaults?: { env?: string };
  },
) {
  return {
    ...(secrets ? { secrets } : {}),
    plugins: {
      entries: {
        searxng: {
          config: { webSearch: { baseUrl } },
        },
      },
    },
  } as never;
}

describe("searxng web search provider", () => {
  let createSearxngWebSearchProvider: typeof import("./searxng-search-provider.js").createSearxngWebSearchProvider;
  let plugin: typeof import("../index.js").default;

  beforeAll(async () => {
    ({ createSearxngWebSearchProvider } = await import("./searxng-search-provider.js"));
    ({ default: plugin } = await import("../index.js"));
  });

  beforeEach(() => {
    runSearxngSearch.mockReset();
    runSearxngSearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  it("registers a setup-visible web search provider", () => {
    const webSearchProviders: unknown[] = [];

    plugin.register({
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(plugin.id).toBe("searxng");
    expect(webSearchProviders).toHaveLength(1);

    const provider = webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("searxng");
    expect(provider.requiresCredential).toBe(true);
    expect(provider.envVars).toEqual(["SEARXNG_BASE_URL"]);
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
  });

  it("exposes credential metadata and enables the plugin in config", () => {
    const provider = createSearxngWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("searxng");
    expect(provider.label).toBe("SearXNG Search");
    expect(provider.requiresCredential).toBe(true);
    expect(provider.credentialPath).toBe("plugins.entries.searxng.config.webSearch.baseUrl");
    expect(applied.plugins?.entries?.searxng?.enabled).toBe(true);
  });

  it("maps generic tool arguments into SearXNG search params", async () => {
    const provider = createSearxngWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });

    expect(runSearxngSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });
  });

  it("rejects fractional and out-of-range counts before searching", async () => {
    const provider = createSearxngWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "openclaw docs", count: 4.5 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    await expect(tool.execute({ query: "openclaw docs", count: 11 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    expect(runSearxngSearch).not.toHaveBeenCalled();
  });

  it("uses a configured literal and falls back to ambient env only when config is missing", () => {
    expect(
      resolveSearxngBaseUrl(buildSearxngConfig(" https://configured.example///"), {
        SEARXNG_BASE_URL: "https://ambient.example/",
      }),
    ).toBe("https://configured.example");
    expect(
      resolveSearxngBaseUrl({} as never, {
        SEARXNG_BASE_URL: "https://search.local/searxng///",
      }),
    ).toBe("https://search.local/searxng");
    expect(resolveSearxngBaseUrl(buildSearxngConfig(""), {})).toBeUndefined();
  });

  it.each([
    {
      name: "implicit default env provider",
      ref: { source: "env", provider: "default", id: "SEARXNG_BASE_URL" },
      secrets: undefined,
    },
    {
      name: "configured env provider with exact allowlist entry",
      ref: { source: "env", provider: "restricted", id: "SEARXNG_BASE_URL" },
      secrets: {
        providers: { restricted: { source: "env", allowlist: ["SEARXNG_BASE_URL"] } },
      },
    },
    {
      name: "configured default provider for a legacy ref",
      ref: { source: "env", id: "SEARXNG_BASE_URL" },
      secrets: {
        defaults: { env: "restricted" },
        providers: { restricted: { source: "env", allowlist: ["SEARXNG_BASE_URL"] } },
      },
    },
  ])("resolves an allowed env SecretRef: $name", ({ ref, secrets }) => {
    expect(
      resolveSearxngBaseUrl(buildSearxngConfig(ref, secrets), {
        SEARXNG_BASE_URL: "http://localhost:8888///",
      }),
    ).toBe("http://localhost:8888");
  });

  it.each([
    {
      name: "non-env source",
      ref: { source: "file", provider: "default", id: "SEARXNG_BASE_URL" },
      secrets: undefined,
    },
    {
      name: "wrong env id",
      ref: { source: "env", provider: "default", id: "OTHER_BASE_URL" },
      secrets: undefined,
    },
    {
      name: "env provider allowlist denial",
      ref: { source: "env", provider: "restricted", id: "SEARXNG_BASE_URL" },
      secrets: { providers: { restricted: { source: "env", allowlist: [] } } },
    },
    {
      name: "unknown non-default provider",
      ref: { source: "env", provider: "unknown", id: "SEARXNG_BASE_URL" },
      secrets: undefined,
    },
    {
      name: "provider configured for a different source",
      ref: { source: "env", provider: "mounted", id: "SEARXNG_BASE_URL" },
      secrets: {
        providers: { mounted: { source: "file", path: "/tmp/secrets", mode: "json" } },
      },
    },
    {
      name: "malformed explicit ref",
      ref: { source: "env", provider: "default" },
      secrets: undefined,
    },
  ])("blocks an explicit SecretRef without ambient fallback: $name", ({ ref, secrets }) => {
    expect(
      resolveSearxngBaseUrl(buildSearxngConfig(ref, secrets), {
        SEARXNG_BASE_URL: "https://ambient.example/",
        OTHER_BASE_URL: "https://other.example/",
      }),
    ).toBeUndefined();
  });

  it("reads categories and language from plugin config", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                categories: "general,news",
                language: "de",
              },
            },
          },
        },
      },
    } as never;

    expect(resolveSearxngCategories(config)).toBe("general,news");
    expect(resolveSearxngLanguage(config)).toBe("de");
  });

  it("exposes a credentialNote with JSON format guidance", () => {
    const provider = createSearxngWebSearchProvider();

    expect(provider.credentialNote).toContain("json format enabled");
    expect(provider.credentialNote).toContain("search.formats");
  });

  it("persists base URL to plugin config via setConfiguredCredentialValue", () => {
    const provider = createSearxngWebSearchProvider();
    const config = {} as Record<string, unknown>;
    const setConfiguredCredentialValue = provider.setConfiguredCredentialValue;
    if (!setConfiguredCredentialValue) {
      throw new Error("Expected SearXNG provider setConfiguredCredentialValue");
    }

    setConfiguredCredentialValue(config, "http://search.local:9000");

    expect(
      (
        config as {
          plugins?: { entries?: { searxng?: { config?: { webSearch?: { baseUrl?: string } } } } };
        }
      ).plugins?.entries?.searxng?.config?.webSearch?.baseUrl,
    ).toBe("http://search.local:9000");
  });
});
