import { MessageFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { DiscordError } from "./internal/rest-errors.js";
import { DISCORD_REST_TIMEOUT_MS } from "./internal/rest.js";
import { sendWebhookMessageDiscord as sendWebhook } from "./send.webhook.js";

const { makeProxyFetchMock, recordChannelActivityMock, guardedFetchMock } = vi.hoisted(() => ({
  makeProxyFetchMock: vi.fn(),
  recordChannelActivityMock: vi.fn(),
  guardedFetchMock: vi.fn<typeof fetchWithSsrFGuard>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetchMock,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  makeProxyFetch: makeProxyFetchMock,
}));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity: recordChannelActivityMock,
}));

const cfg: OpenClawConfig = { channels: { discord: { token: "Bot test-token" } } };
const opts = { cfg, webhookId: "123", webhookToken: "abc" };
let fetchMock: MockInstance<typeof fetch>;

async function expectDeadline() {
  const rejection = expect(sendWebhook("hello", opts)).rejects.toMatchObject({
    name: "TimeoutError",
    message: "request timed out",
  });
  await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
}

describe("Discord webhook transport", () => {
  it.each(["explicit revoked", "inherited revoked", "both current", "unguarded"] as const)(
    "configured webhook authority: %s",
    async (kind) => {
      vi.stubEnv("DISCORD_API_URL", "http://127.0.0.1:43210/api/v10");
      const entered = createDeferred<void>();
      const releasePreflight = createDeferred<void>();
      const releaseGuard = vi.fn(async () => {});
      let current = true;
      const failure = new Error("synthetic writer replaced during endpoint preflight");
      const explicit = vi.fn(() => {
        if (!current) {
          throw failure;
        }
      });
      const inherited = vi.fn(() => {
        if (!current) {
          throw failure;
        }
      });
      const onDispatch = vi.fn(async () => {});
      const onResult = vi.fn();
      guardedFetchMock.mockImplementation(async (params) => {
        entered.resolve();
        await releasePreflight.promise;
        params.beforeRequest?.();
        const response = await globalThis.fetch(params.url, params.init);
        return { response, finalUrl: params.url, release: releaseGuard };
      });
      const sending = withDiscordRequestAuthority(
        kind === "inherited revoked" || kind === "both current" ? inherited : undefined,
        () =>
          sendWebhook("retained authority", {
            ...opts,
            threadId: "thread-1",
            assertPlatformSendAuthorized:
              kind === "explicit revoked" || kind === "both current" ? explicit : undefined,
            onPlatformSendDispatch: onDispatch,
            onDeliveryResult: onResult,
          }),
      ).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        await Promise.race([
          entered.promise,
          sending.then(() => {
            throw new Error("Webhook settled before configured preflight");
          }),
        ]);
        expect(onDispatch).toHaveBeenCalledOnce();
        expect(fetchMock).not.toHaveBeenCalled();
        if (kind.endsWith("revoked")) {
          current = false;
        }
        releasePreflight.resolve();
        const outcome = await sending;
        expect(guardedFetchMock).toHaveBeenCalledOnce();
        expect(guardedFetchMock).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "http://127.0.0.1:43210/api/v10/webhooks/123/abc?wait=true&thread_id=thread-1",
            capture: false,
            maxRedirects: 0,
            auditContext: "discord.endpoint-runtime",
          }),
        );
        if (kind.endsWith("revoked")) {
          expect(outcome.error).toBe(failure);
          expect(outcome.result).toBeUndefined();
          expect(fetchMock).not.toHaveBeenCalled();
          expect(recordChannelActivityMock).not.toHaveBeenCalled();
          expect(onResult).not.toHaveBeenCalled();
          expect(releaseGuard).not.toHaveBeenCalled();
          expect(kind === "explicit revoked" ? explicit : inherited).toHaveBeenCalled();
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result).toMatchObject({
            messageId: "msg-1",
            channelId: "thread-1",
            receipt: { platformMessageIds: ["msg-1"], threadId: "thread-1" },
          });
          expect(fetchMock).toHaveBeenCalledOnce();
          const [url, init] = fetchMock.mock.calls[0]!;
          expect(url).toBe(
            "http://127.0.0.1:43210/api/v10/webhooks/123/abc?wait=true&thread_id=thread-1",
          );
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
          expect(JSON.parse(await new Response(init?.body).text())).toEqual({
            content: "retained authority",
            flags: MessageFlags.SuppressEmbeds,
          });
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(init?.signal?.aborted).toBe(false);
          expect(recordChannelActivityMock).toHaveBeenCalledOnce();
          expect(onResult).toHaveBeenCalledOnce();
          expect(releaseGuard).toHaveBeenCalledOnce();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releasePreflight.resolve();
        await sending;
        vi.unstubAllEnvs();
      }
    },
  );

  beforeEach(() => {
    makeProxyFetchMock.mockReset();
    recordChannelActivityMock.mockClear();
    guardedFetchMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "msg-1", channel_id: "thread-1" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("applies account opt-out of link-preview suppression", async () => {
    await sendWebhook("https://example.com", {
      ...opts,
      cfg: {
        channels: {
          discord: { suppressEmbeds: true, accounts: { runtime: { suppressEmbeds: false } } },
        },
      },
      accountId: "runtime",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ content: "https://example.com" }),
    );
  });

  it("uses the configured proxy fetch", async () => {
    const proxiedFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "proxied" }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);
    await sendWebhook("hello", {
      ...opts,
      cfg: { channels: { discord: { proxy: "http://proxy.test:8080" } } },
    });
    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the no-body response when wait is false", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);
    expect((await sendWebhook("hello", { ...opts, wait: false })).messageId).toBe("");
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("keeps an accepted send when the response body exceeds the limit", async () => {
    const tracked = cancelTrackedTextResponse(`{"id":"${"x".repeat(16 * 1024 * 1024)}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    fetchMock.mockResolvedValue(tracked.response);
    expect((await sendWebhook("hello", opts)).messageId).toBe("");
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each(["rate limit", "pre-connect failure"] as const)(
    "retries a proven %s within its budget and cleans up the deadline",
    async (failure) => {
      if (failure === "rate limit") {
        fetchMock.mockImplementation(async () =>
          Response.json(
            { message: "Slow down", retry_after: 0.75, global: false },
            { status: 429 },
          ),
        );
      } else {
        fetchMock.mockRejectedValueOnce(
          Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
        );
      }
      const sent = sendWebhook("hello", { ...opts, threadId: "thread-1" });
      const result =
        failure === "rate limit"
          ? expect(sent).rejects.toMatchObject({
              name: "RateLimitError",
              status: 429,
              retryAfter: 0.75,
            })
          : expect(sent).resolves.toMatchObject({ messageId: "msg-1", channelId: "thread-1" });
      if (failure === "rate limit") {
        await vi.advanceTimersByTimeAsync(749);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(failure === "rate limit" ? 3 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds an ambiguous error body without replaying the send", async () => {
    const tracked = cancelTrackedTextResponse(`${"upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchMock.mockResolvedValue(tracked.response);
    const error: unknown = await sendWebhook("hello", opts).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DiscordError);
    if (!(error instanceof DiscordError)) {
      throw error;
    }
    expect(error.status).toBe(503);
    expect(error.message).toContain("upstream unavailable");
    expect(JSON.stringify(error.rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts when Discord never returns response headers", async () => {
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    });
    await expectDeadline();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([200, 503])("keeps the deadline active through a stalled %s body", async (status) => {
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { status },
      );
    });
    await expectDeadline();
  });

  it("aborts rate-limit backoff at the deadline without leaving a retry timer", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ message: "Slow down", retry_after: 60 }, { status: 429 }),
    );
    await expectDeadline();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
