import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createKimiWebSearchProvider } from "./kimi-web-search-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["reasoning_content", "reasoning", "choices"] as const)(
  "native Kimi search never publishes auxiliary %s",
  async (field) => {
    const privateText = "private analysis must stay private";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        [field]: privateText,
        search_results: [
          {
            url: "https://example.com/evidence",
            title: "Supported title",
            snippet: "Verified snippet",
            [field]: privateText,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await withEnvAsync({ KIMI_API_KEY: "synthetic-test-key" }, async () => {
      const tool = createKimiWebSearchProvider().createTool({ config: {}, searchConfig: {} });
      if (!tool) throw new Error("Expected Kimi search tool");
      const result = await tool.execute({ query: "native-isolation-" + field });
      expect(JSON.stringify(result)).toContain("Verified snippet");
      expect(JSON.stringify(result)).not.toContain(privateText);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/tools/search");
    });
  },
);

it("rejects legacy reasoning-only chat output without caching it", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ choices: [{ message: { reasoning_content: "private" } }] }),
    )
    .mockResolvedValueOnce(
      Response.json({
        search_results: [{ url: "https://example.com", snippet: "Later valid result" }],
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  await withEnvAsync({ KIMI_API_KEY: "synthetic-test-key" }, async () => {
    const tool = createKimiWebSearchProvider().createTool({ config: {}, searchConfig: {} });
    if (!tool) throw new Error("Expected Kimi search tool");
    await expect(tool.execute({ query: "reasoning-failure-cache" })).rejects.toThrow();
    expect(JSON.stringify(await tool.execute({ query: "reasoning-failure-cache" }))).toContain(
      "Later valid result",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
