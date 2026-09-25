import { createServer, type Server } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsDelegatedOAuthContext } from "./oauth.shared.js";

const control = vi.hoisted(() => ({ port: 0, failure: "" }));
const exchange = vi.hoisted(() => vi.fn());

vi.mock("./oauth.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.shared.js")>()),
  MSTEAMS_OAUTH_CALLBACK_PORT: control.port,
  MSTEAMS_OAUTH_REDIRECT_URI: `http://127.0.0.1:${control.port}/oauth2callback`,
}));
vi.mock("./oauth.token.js", () => ({ exchangeMSTeamsCodeForTokens: exchange }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    waitForLocalOAuthCallback: (params: Parameters<typeof actual.waitForLocalOAuthCallback>[0]) => {
      if (control.failure === "bind") {
        return Promise.reject(new Error("listen EACCES"));
      }
      if (control.failure === "timeout") {
        params.onProgress?.("Listener ready");
        return Promise.reject(new Error("OAuth callback timed out"));
      }
      return actual.waitForLocalOAuthCallback(params);
    },
  };
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no loopback port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function callbackUrl(authUrl: string, query: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${control.port}/oauth2callback`);
  const state = new URL(authUrl).searchParams.get("state");
  if (!state) {
    throw new Error("missing OAuth state");
  }
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

function context(openUrl: MSTeamsDelegatedOAuthContext["openUrl"] = vi.fn()): {
  ctx: MSTeamsDelegatedOAuthContext;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      isRemote: false,
      openUrl,
      log: (message) => logs.push(message),
      note: async () => {},
      prompt: async () => {
        const authUrl = logs.join("\n").match(/https:\/\/\S+/)?.[0];
        if (!authUrl) {
          throw new Error("manual URL missing");
        }
        return callbackUrl(authUrl, { code: "manual-code" });
      },
      progress: { update: () => {}, stop: () => {} },
    },
  };
}

const params = { tenantId: "tenant", clientId: "client", clientSecret: "secret" }; // pragma: allowlist secret
let login: typeof import("./oauth.js").loginMSTeamsDelegated;
let occupied: Server | undefined;

beforeAll(async () => {
  control.port = await freePort();
});
beforeEach(async () => {
  control.failure = "";
  exchange.mockReset().mockImplementation(async ({ code }: { code: string }) => ({
    accessToken: code,
    refreshToken: "refresh",
    expiresAt: 1,
    scopes: [],
  }));
  vi.resetModules();
  ({ loginMSTeamsDelegated: login } = await import("./oauth.js"));
});
afterEach(async () => {
  if (occupied) {
    await new Promise<void>((resolve) => occupied!.close(() => resolve()));
    occupied = undefined;
  }
});

describe("MSTeams delegated OAuth loopback ordering", () => {
  it("captures an immediate browser redirect after the listener is ready", async () => {
    const openUrl = vi.fn(async (url: string) => {
      const response = await fetch(callbackUrl(url, { code: "immediate" }));
      expect(response.status).toBe(200);
    });
    const { ctx } = context(openUrl);
    expect((await login(ctx, params)).accessToken).toBe("immediate");
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it("captures a delayed browser redirect", async () => {
    const openUrl = vi.fn(async (url: string) => {
      await Promise.resolve();
      await fetch(callbackUrl(url, { code: "delayed" }));
    });
    expect((await login(context(openUrl).ctx, params)).accessToken).toBe("delayed");
  });

  it("logs the manual URL after an asynchronous browser-open rejection", async () => {
    const openUrl = vi.fn(async (_url: string) => {
      throw new Error("browser unavailable");
    });
    const { ctx, logs } = context(openUrl);
    const pending = login(ctx, params);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("Open this URL"));
    const authUrl = openUrl.mock.calls[0]?.[0] as string;
    await fetch(callbackUrl(authUrl, { code: "after-reject" }));
    expect((await pending).accessToken).toBe("after-reject");
  });

  it("logs the manual URL after a synchronous browser-open throw", async () => {
    const openUrl = vi.fn((_url: string): Promise<void> => {
      throw new Error("no browser");
    });
    const { ctx, logs } = context(openUrl);
    const pending = login(ctx, params);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("Open this URL"));
    const authUrl = openUrl.mock.calls[0]?.[0] as string;
    await fetch(callbackUrl(authUrl, { code: "after-throw" }));
    expect((await pending).accessToken).toBe("after-throw");
  });

  it("falls back to a pasted callback when the loopback port is occupied", async () => {
    occupied = createServer();
    await new Promise<void>((resolve) => occupied!.listen(control.port, "127.0.0.1", resolve));
    const openUrl = vi.fn(async () => {});
    const { ctx } = context(openUrl);
    expect((await login(ctx, params)).accessToken).toBe("manual-code");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("falls back to a pasted callback for another listen failure", async () => {
    control.failure = "bind";
    const openUrl = vi.fn(async () => {});
    expect((await login(context(openUrl).ctx, params)).accessToken).toBe("manual-code");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores a mismatched state and accepts the subsequent valid callback", async () => {
    const openUrl = vi.fn(async (url: string) => {
      const wrong = await fetch(callbackUrl(url, { state: "wrong", code: "wrong" }));
      expect(wrong.status).not.toBe(200);
      const good = await fetch(callbackUrl(url, { code: "right" }));
      expect(good.status).toBe(200);
    });
    expect((await login(context(openUrl).ctx, params)).accessToken).toBe("right");
  });

  it("rejects an OAuth callback error without manual fallback", async () => {
    const openUrl = vi.fn(async (url: string) => {
      await fetch(callbackUrl(url, { error: "access_denied" }));
    });
    const { ctx } = context(openUrl);
    await expect(login(ctx, params)).rejects.toThrow("OAuth error: access_denied");
  });

  it("propagates callback timeout without manual fallback", async () => {
    control.failure = "timeout";
    const { ctx } = context(vi.fn(async () => {}));
    await expect(login(ctx, params)).rejects.toThrow("OAuth callback timed out");
  });

  it("propagates token-exchange failure after a valid callback", async () => {
    exchange.mockRejectedValueOnce(new Error("token exchange failed"));
    const openUrl = vi.fn(async (url: string) => {
      await fetch(callbackUrl(url, { code: "valid" }));
    });
    await expect(login(context(openUrl).ctx, params)).rejects.toThrow("token exchange failed");
  });
});
