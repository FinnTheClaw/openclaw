import { afterEach, describe, expect, it, vi } from "vitest";
const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({ fetchWithSsrFGuardMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));
import { createOllamaStreamFn } from "./stream.runtime.js";

afterEach(() => vi.clearAllMocks());
describe("native Ollama HTTP header field case", () => {
  it.each<{
    name: string;
    headers: Record<string, string>;
    requestHeaders?: Record<string, string>;
    apiKey: string;
    expected: string;
  }>([
    {
      name: "marker preserves lowercase explicit auth",
      headers: { authorization: "Bearer proxy-token" },
      apiKey: "ollama-local",
      expected: "Bearer proxy-token",
    },
    {
      name: "real key replaces lowercase explicit auth",
      headers: { authorization: "Bearer stale-token" },
      apiKey: "synthetic-new-token",
      expected: "Bearer synthetic-new-token",
    },
    {
      name: "request header replaces differently cased default",
      headers: { Authorization: "Bearer old-token" },
      requestHeaders: { authorization: "Bearer request-token" },
      apiKey: "ollama-local",
      expected: "Bearer request-token",
    },
  ])("$name", async ({ headers, requestHeaders, apiKey, expected }) => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          model: "test-model",
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n",
      ),
      release: async () => {},
    });
    const streamFn = createOllamaStreamFn("http://127.0.0.1:11434", headers);
    const stream = await streamFn(
      {
        id: "test-model",
        name: "Test model",
        baseUrl: "http://127.0.0.1:11434",
        provider: "ollama",
        api: "ollama",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey, headers: requestHeaders },
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("done");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as { init: RequestInit };
    expect(new Headers(request.init.headers).get("authorization")).toBe(expected);
  });
});
