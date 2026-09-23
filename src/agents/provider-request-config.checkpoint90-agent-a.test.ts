import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PinnedHostname } from "../infra/net/ssrf.js";
import {
  buildProviderRequestDispatcherPolicy,
  resolveProviderRequestConfig,
} from "./provider-request-config.js";

const KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const { agentCtor, envCtor, proxyCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function (
    this: { options: unknown; dispatch: () => boolean },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = () => true;
  }),
  envCtor: vi.fn(function (this: { options: unknown; dispatch: () => boolean }, options: unknown) {
    this.options = options;
    this.dispatch = () => true;
  }),
  proxyCtor: vi.fn(function (
    this: { options: unknown; dispatch: () => boolean },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = () => true;
  }),
}));

let createPinnedDispatcher: typeof import("../infra/net/ssrf.js").createPinnedDispatcher;
beforeAll(async () => {
  ({ createPinnedDispatcher } = await import("../infra/net/ssrf.js"));
});
beforeEach(() => {
  agentCtor.mockClear();
  envCtor.mockClear();
  proxyCtor.mockClear();
  (globalThis as Record<string, unknown>)[KEY] = {
    Agent: agentCtor,
    EnvHttpProxyAgent: envCtor,
    ProxyAgent: proxyCtor,
    fetch: vi.fn(),
  };
});
afterEach(() => Reflect.deleteProperty(globalThis, KEY));

function policy(
  request: NonNullable<Parameters<typeof resolveProviderRequestConfig>[0]["request"]>,
) {
  return buildProviderRequestDispatcherPolicy(
    resolveProviderRequestConfig({
      provider: "custom-openai",
      baseUrl: "https://api.example.test/v1",
      request,
    }),
  );
}
function pinned(): PinnedHostname {
  return {
    hostname: "api.example.test",
    addresses: ["203.0.113.8"],
    lookup: vi.fn() as PinnedHostname["lookup"],
  };
}
function proxyOptions(): Record<string, unknown> {
  const call = proxyCtor.mock.calls.at(-1);
  if (!call) {
    throw new Error("proxy constructor was not called");
  }
  return call[0] as Record<string, unknown>;
}

describe("checkpoint 90 explicit proxy target TLS", () => {
  it("direct-custom-CA", () => {
    expect(policy({ tls: { ca: "target-ca" } })).toEqual({
      mode: "direct",
      connect: { ca: "target-ca" },
    });
  });
  it("env-custom-CA", () => {
    expect(policy({ proxy: { mode: "env-proxy" }, tls: { ca: "target-ca" } })).toEqual({
      mode: "env-proxy",
      connect: { ca: "target-ca" },
    });
  });
  it("explicit-http-custom-CA", () => {
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "http://proxy.test" },
      tls: { ca: "target-ca" },
    });
    expect(entry).toMatchObject({ mode: "explicit-proxy", requestTls: { ca: "target-ca" } });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({
      ca: "target-ca",
      lookup: expect.any(Function),
    });
  });
  it("explicit-https-custom-CA", () => {
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "https://proxy.test" },
      tls: { ca: "target-ca" },
    });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({
      ca: "target-ca",
      lookup: expect.any(Function),
    });
  });
  it("explicit-client-cert", () => {
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "http://proxy.test" },
      tls: { cert: "client-cert" },
    });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({ cert: "client-cert" });
  });
  it("explicit-client-key", () => {
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "http://proxy.test" },
      tls: { key: "client-key" },
    });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({ key: "client-key" });
  });
  it("proxy-CA-distinct-from-target-CA", () => {
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "https://proxy.test", tls: { ca: "proxy-ca" } },
      tls: { ca: "target-ca" },
    });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({ ca: "target-ca" });
    expect(proxyOptions().proxyTls).toMatchObject({ ca: "proxy-ca" });
    expect(proxyOptions().proxyTls).not.toHaveProperty("lookup");
  });
  it("pinned-DNS-target", () => {
    const host = pinned();
    const entry = policy({
      proxy: { mode: "explicit-proxy", url: "http://proxy.test" },
      tls: { ca: "target-ca" },
    });
    createPinnedDispatcher(host, entry);
    expect((proxyOptions().requestTls as Record<string, unknown>).lookup).toBe(host.lookup);
  });
  it("HTTP-proxy-no-target-TLS", () => {
    const entry = policy({ proxy: { mode: "explicit-proxy", url: "http://proxy.test" } });
    createPinnedDispatcher(pinned(), entry);
    expect(proxyOptions().requestTls).toMatchObject({ lookup: expect.any(Function) });
    expect(proxyOptions().proxyTls).not.toHaveProperty("ca");
  });
  it("malformed-proxy-rejected", () => {
    const entry = policy({ proxy: { mode: "explicit-proxy", url: "not-a-url" } });
    Reflect.deleteProperty(globalThis, KEY);
    expect(() => createPinnedDispatcher(pinned(), entry)).toThrow();
  });
});
