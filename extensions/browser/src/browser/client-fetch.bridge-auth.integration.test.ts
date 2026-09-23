import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserControlAuth } from "./control-auth.js";

const authState = vi.hoisted(() => ({
  globalAuth: undefined as { token?: string; password?: string } | undefined,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () =>
      ({
        gateway: {
          auth: authState.globalAuth,
        },
      }) as ReturnType<typeof actual.getRuntimeConfig>,
  };
});

vi.mock("./control-auth.js", async () => {
  const actual = await vi.importActual<typeof import("./control-auth.js")>("./control-auth.js");
  return {
    ...actual,
    resolveBrowserControlAuth: vi.fn((): BrowserControlAuth => authState.globalAuth ?? {}),
  };
});

const { fetchBrowserJson, BrowserServiceError } = await import("./client-fetch.js");
const { startBrowserBridgeServer, stopBrowserBridgeServer } = await import("./bridge-server.js");
const { resolveBrowserConfig } = await import("./config.js");

type BridgeCredential = { token?: string; password?: string };
type BridgeAuthCase = {
  id: string;
  description: string;
  globalAuth?: BridgeCredential;
  bridgeAuth: BridgeCredential;
  headers?: Record<string, string>;
  expectedStatus: 401 | 404;
};

const cases: BridgeAuthCase[] = [
  {
    id: "BROWSER-R4-01-C01",
    description: "configured token does not override the bridge token",
    globalAuth: { token: "global-token-c01" },
    bridgeAuth: { token: "bridge-token-c01" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C02",
    description: "configured password does not override the bridge token",
    globalAuth: { password: "global-password-c02" },
    bridgeAuth: { token: "bridge-token-c02" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C03",
    description: "configured token does not override the bridge password",
    globalAuth: { token: "global-token-c03" },
    bridgeAuth: { password: "bridge-password-c03" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C04",
    description: "configured password does not override the bridge password",
    globalAuth: { password: "global-password-c04" },
    bridgeAuth: { password: "bridge-password-c04" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C05",
    description: "bridge token works without configured global auth",
    bridgeAuth: { token: "bridge-token-c05" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C06",
    description: "bridge password works without configured global auth",
    bridgeAuth: { password: "bridge-password-c06" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C07",
    description: "caller authorization header retains precedence over registered credentials",
    globalAuth: { token: "global-token-c07" },
    bridgeAuth: { token: "bridge-token-c07" },
    headers: { authorization: "Bearer bridge-token-c07" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C08",
    description: "caller authorization header is not replaced by bridge auth",
    globalAuth: { token: "global-token-c08" },
    bridgeAuth: { token: "bridge-token-c08" },
    headers: { authorization: "Bearer caller-token-c08" },
    expectedStatus: 401,
  },
  {
    id: "BROWSER-R4-01-C09",
    description: "caller password header is preserved for a password bridge",
    globalAuth: { token: "global-token-c09" },
    bridgeAuth: { password: "bridge-password-c09" },
    headers: { "x-openclaw-password": "bridge-password-c09" },
    expectedStatus: 404,
  },
  {
    id: "BROWSER-R4-01-C10",
    description: "caller password header is not replaced by configured or bridge auth",
    globalAuth: { token: "global-token-c10" },
    bridgeAuth: { password: "bridge-password-c10" },
    headers: { "x-openclaw-password": "caller-password-c10" },
    expectedStatus: 401,
  },
];

describe("attached browser loopback bridge authentication", () => {
  let bridge: Awaited<ReturnType<typeof startBrowserBridgeServer>> | undefined;

  beforeEach(() => {
    authState.globalAuth = undefined;
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(async () => {
    if (bridge) {
      await stopBrowserBridgeServer(bridge.server);
      bridge = undefined;
    }
    vi.unstubAllEnvs();
  });

  it.each(cases)("$id: $description", async (testCase) => {
    authState.globalAuth = testCase.globalAuth;
    bridge = await startBrowserBridgeServer({
      resolved: resolveBrowserConfig(undefined, {}),
      host: "127.0.0.1",
      port: 0,
      authToken: testCase.bridgeAuth.token,
      authPassword: testCase.bridgeAuth.password,
    });

    const response = await fetchBrowserJson(`${bridge.baseUrl}/__auth_probe`, {
      headers: testCase.headers,
    }).then(
      () => ({ status: 200 }),
      (error: unknown) => ({
        status: error instanceof BrowserServiceError ? (error.status ?? 0) : 0,
      }),
    );

    // A valid credential reaches the ordinary 404 route; a bad credential is
    // rejected by the real bridge auth middleware before route dispatch.
    expect(response.status).toBe(testCase.expectedStatus);
    expect(bridge.port).toBeGreaterThan(0);
    expect(new URL(bridge.baseUrl).port).toBe(String(bridge.port));
  });
});
