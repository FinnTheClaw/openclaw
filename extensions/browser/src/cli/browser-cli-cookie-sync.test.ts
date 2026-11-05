import { EventEmitter } from "node:events";
import { Command } from "commander";
import * as cliRuntime from "openclaw/plugin-sdk/cli-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import * as runtimeConfigSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true, targetId: "tab-1", added: 1 })),
}));

const watchMocks = vi.hoisted(() => ({
  watch: vi.fn(),
  readSecret: vi.fn(),
  cacheKeychainSecret: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, watch: watchMocks.watch } };
});
vi.mock("../browser/system-chrome-cookies.js", () => ({
  cacheKeychainSecret: watchMocks.cacheKeychainSecret,
}));

const systemProfileMocks = vi.hoisted(() => ({
  assertSystemCookiePlatform: vi.fn(),
  resolveSystemCookieSource: vi.fn(() => ({
    browser: "chrome",
    cookiesFile: "/synthetic/Cookies",
  })),
  readSystemProfileCookies: vi.fn(async () => ({
    browser: "chrome" as const,
    systemProfile: "Default",
    cookies: [
      {
        name: "session",
        value: "cookie-secret",
        domain: ".example.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ],
    counts: { total: 2, imported: 1, failed: 0, skipped: 1 },
    domains: [".example.com"],
  })),
}));

vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(gatewayMocks.callGatewayFromCli);

vi.mock("../system-profile-api.js", () => ({
  assertSystemCookiePlatform: systemProfileMocks.assertSystemCookiePlatform,
  readSystemProfileCookies: systemProfileMocks.readSystemProfileCookies,
  resolveSystemCookieSource: systemProfileMocks.resolveSystemCookieSource,
}));

vi.spyOn(cliRuntime, "runCommandWithRuntime").mockImplementation(
  async (_runtime, action, onError) => {
    try {
      await action();
    } catch (error) {
      onError?.(error);
    }
  },
);
vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);

const getRuntimeConfigMock = vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig");

let registerBrowserCookieSyncCommand: typeof import("./browser-cli-cookie-sync.js").registerBrowserCookieSyncCommand;

function createProgram() {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--url <url>", "Gateway URL")
    .option("--token <token>", "Gateway token")
    .option("--timeout <ms>", "Timeout", "30000");
  registerBrowserCookieSyncCommand(browser, (command) => command.optsWithGlobals());
  return program;
}

describe("browser cookie-sync CLI", () => {
  beforeAll(async () => {
    ({ registerBrowserCookieSyncCommand } = await import("./browser-cli-cookie-sync.js"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    runtime.error.mockClear();
    getRuntimeConfigMock.mockReturnValue({});
    watchMocks.watch.mockReset();
    watchMocks.cacheKeychainSecret.mockReset().mockResolvedValue(watchMocks.readSecret);
    systemProfileMocks.assertSystemCookiePlatform.mockClear();
    systemProfileMocks.resolveSystemCookieSource.mockClear();
    gatewayMocks.callGatewayFromCli.mockClear();
    systemProfileMocks.readSystemProfileCookies.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resyncs changes received during a pending push and settles on stop", async () => {
    const config = { browser: { allowSystemProfileImport: true } };
    getRuntimeConfigMock.mockReturnValue(config);
    vi.useFakeTimers();
    const firstPush = createDeferred<{ ok: boolean; targetId: string; added: number }>();
    const secondPush = createDeferred<{ ok: boolean; targetId: string; added: number }>();
    gatewayMocks.callGatewayFromCli.mockImplementationOnce(async () => firstPush.promise);
    gatewayMocks.callGatewayFromCli.mockImplementationOnce(async () => secondPush.promise);
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    let changed: (event: string, filename: string) => void = () => {};
    watchMocks.watch.mockImplementation((_path, listener) => {
      changed = listener;
      return watcher;
    });
    const running = createProgram().parseAsync(
      ["browser", "cookie-sync", "--domains", "example.com", "--watch"],
      { from: "user" },
    );
    try {
      await vi.waitFor(() => expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(1));
      config.browser.allowSystemProfileImport = false;
      changed("change", "Cookies-wal");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(1);
      firstPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await vi.waitFor(() => expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(2));
      changed("change", "Cookies");
      await vi.advanceTimersByTimeAsync(1_500);
      process.emit("SIGINT");
      secondPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await running;
      expect(systemProfileMocks.readSystemProfileCookies).toHaveBeenCalledTimes(2);
      expect(watcher.close).toHaveBeenCalledOnce();
    } finally {
      process.emit("SIGINT");
      firstPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      secondPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await running;
    }
  });

  it.each([
    { mode: "one-shot", watch: false },
    { mode: "watch", watch: true },
  ])("system profile import admission: disabled $mode", async ({ watch }) => {
    getRuntimeConfigMock.mockReturnValue({ browser: { allowSystemProfileImport: false } });
    if (watch) {
      // A reached cache boundary must terminate the unguarded original without a watcher.
      watchMocks.cacheKeychainSecret.mockRejectedValueOnce(
        new Error("fixture: disabled watch reached Keychain cache"),
      );
    }
    const exitError = await createProgram()
      .parseAsync(
        ["browser", "cookie-sync", "--domains", "example.com", ...(watch ? ["--watch"] : [])],
        { from: "user" },
      )
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect({
      exitError,
      errors: runtime.error.mock.calls.map(([message]) =>
        String(message).replace(/\u001b\[[0-9;]*m/g, ""),
      ),
      sourceReads: systemProfileMocks.readSystemProfileCookies.mock.calls.length,
      platformChecks: systemProfileMocks.assertSystemCookiePlatform.mock.calls.length,
      sourceResolutions: systemProfileMocks.resolveSystemCookieSource.mock.calls.length,
      keychainCaches: watchMocks.cacheKeychainSecret.mock.calls.length,
      watchers: watchMocks.watch.mock.calls.length,
      gatewayCalls: gatewayMocks.callGatewayFromCli.mock.calls.length,
    }).toEqual({
      exitError: "__exit__:1",
      errors: ["Error: system profile import is disabled (browser.allowSystemProfileImport=false)"],
      sourceReads: 0,
      platformChecks: 0,
      sourceResolutions: 0,
      keychainCaches: 0,
      watchers: 0,
      gatewayCalls: 0,
    });
  });

  it("requires a non-empty domain allowlist before any read or gateway call", async () => {
    await expect(
      createProgram().parseAsync(["browser", "cookie-sync"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("--domains is required");
    expect(systemProfileMocks.readSystemProfileCookies).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("reads allowlisted cookies locally and posts them through browser.request", async () => {
    await createProgram().parseAsync(
      [
        "browser",
        "--url",
        "wss://gateway.example",
        "--token",
        "test-token",
        "cookie-sync",
        "--domains",
        "example.com, accounts.example.com",
        "--into",
        "work",
        "--browser",
        "chrome",
        "--system",
        "Profile 1",
      ],
      { from: "user" },
    );

    expect(systemProfileMocks.readSystemProfileCookies).toHaveBeenCalledWith(
      {
        browser: "chrome",
        systemProfile: "Profile 1",
        domains: ["example.com", "accounts.example.com"],
        signal: undefined,
      },
      { readSecret: undefined },
    );
    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ url: "wss://gateway.example", token: "test-token" }),
      {
        method: "POST",
        path: "/cookies/set-many",
        query: { profile: "work" },
        body: {
          cookies: [expect.objectContaining({ name: "session", domain: ".example.com" })],
        },
        timeoutMs: 30_000,
      },
      { progress: undefined, scopes: ["operator.admin"] },
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).toContain(
      "chrome/Default -> work via wss://gateway.example",
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).not.toContain("cookie-secret");
  });
});
