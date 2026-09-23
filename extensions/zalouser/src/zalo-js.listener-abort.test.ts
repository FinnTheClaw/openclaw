import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { API } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
vi.mock("./zca-client.js", () => ({ createZalo: createZaloMock, TextStyle: { Indent: 9 } }));

import { setZalouserRuntime } from "./runtime.js";
import { saveStoredZaloCredentials } from "./session-state.js";
import { startZaloListener } from "./zalo-js.js";

let nextProfile = 0;
function makeApi() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const listener = {
    on: vi.fn((name: string, callback: (...args: never[]) => void) => {
      handlers.set(name, callback);
    }),
    off: vi.fn((name: string) => {
      handlers.delete(name);
    }),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const api = {
    getContext: () => ({ imei: "device", userAgent: "agent", language: "vi" }),
    getCookie: () => ({
      toJSON: () => ({ cookies: [{ key: "zpsid", value: "session", domain: "chat.zalo.me" }] }),
    }),
    listener,
  } as unknown as API;
  return { api, listener, handlers };
}

async function withProfile(
  run: (
    profile: string,
    api: ReturnType<typeof makeApi>,
    controller: AbortController,
  ) => Promise<void>,
  login?: () => Promise<API>,
) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zalo-listener-abort-"));
  const profile = `listener-abort-${++nextProfile}`;
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const api = makeApi();
  const controller = new AbortController();
  saveStoredZaloCredentials(
    profile,
    {
      imei: "device",
      userAgent: "agent",
      createdAt: "2026-04-01T00:00:00.000Z",
      cookie: [{ key: "zpsid", value: "session", domain: "chat.zalo.me" }],
    },
    env,
  );
  createZaloMock.mockResolvedValueOnce({ login: login ?? vi.fn(async () => api.api) });
  try {
    await withEnvAsync(env, async () => await run(profile, api, controller));
  } finally {
    controller.abort();
    resetPluginStateStoreForTests();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function params(profile: string, controller: AbortController) {
  return {
    profile,
    accountId: profile,
    abortSignal: controller.signal,
    onMessage: vi.fn(),
    onError: vi.fn(),
  };
}

describe("Zalo listener abort lifecycle", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("zalouser", options);
    setZalouserRuntime(runtime);
    createZaloMock.mockReset();
  });

  it("Z01 rejects pre-abort before opening a profile", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before startup"));
    await expect(startZaloListener(params("pre-aborted", controller))).rejects.toThrow(
      "cancelled before startup",
    );
    expect(createZaloMock).not.toHaveBeenCalled();
  });
  it("Z02 abort during awaited login never starts the listener", async () => {
    let release!: (api: API) => void;
    const pending = new Promise<API>((resolve) => {
      release = resolve;
    });
    await withProfile(
      async (profile, api, controller) => {
        const starting = startZaloListener(params(profile, controller));
        await vi.waitFor(() => expect(createZaloMock).toHaveBeenCalledTimes(1));
        controller.abort(new Error("cancelled during login"));
        release(api.api);
        await expect(starting).rejects.toThrow("cancelled during login");
        expect(api.listener.start).not.toHaveBeenCalled();
      },
      async () => pending,
    );
  });
  it("Z03 abort during handler registration prevents start", async () => {
    await withProfile(async (profile, api, controller) => {
      api.listener.on.mockImplementationOnce(() =>
        controller.abort(new Error("cancelled before start")),
      );
      await expect(startZaloListener(params(profile, controller))).rejects.toThrow(
        "cancelled before start",
      );
      expect(api.listener.start).not.toHaveBeenCalled();
      expect(api.listener.stop).toHaveBeenCalledTimes(1);
    });
  });
  it("Z04 abort after start stops exactly once", async () => {
    await withProfile(async (profile, api, controller) => {
      await startZaloListener(params(profile, controller));
      expect(api.listener.start).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(api.listener.stop).toHaveBeenCalledTimes(1);
    });
  });
  it("Z05 repeated abort and explicit stop remain idempotent", async () => {
    await withProfile(async (profile, api, controller) => {
      const started = await startZaloListener(params(profile, controller));
      controller.abort();
      started.stop();
      started.stop();
      expect(api.listener.stop).toHaveBeenCalledTimes(1);
    });
  });
  it("Z06 listener start throw detaches handlers", async () => {
    await withProfile(async (profile, api, controller) => {
      api.listener.start.mockImplementationOnce(() => {
        throw new Error("start failed");
      });
      await expect(startZaloListener(params(profile, controller))).rejects.toThrow("start failed");
      expect(api.listener.off).toHaveBeenCalledTimes(3);
      expect(api.listener.stop).toHaveBeenCalledTimes(1);
    });
  });
  it("Z07 emitted listener error cleans up", async () => {
    await withProfile(async (profile, api, controller) => {
      const input = params(profile, controller);
      await startZaloListener(input);
      api.handlers.get("error")?.(new Error("socket failed") as never);
      expect(api.listener.stop).toHaveBeenCalled();
      expect(input.onError).toHaveBeenCalledTimes(1);
    });
  });
  it("Z08 closed event cleans up", async () => {
    await withProfile(async (profile, api, controller) => {
      const input = params(profile, controller);
      await startZaloListener(input);
      api.handlers.get("closed")?.(1006 as never, "network" as never);
      expect(api.listener.stop).toHaveBeenCalled();
      expect(input.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("1006") }),
      );
    });
  });
  it("Z09 same profile restarts after an aborted listener", async () => {
    await withProfile(async (profile, api, controller) => {
      await startZaloListener(params(profile, controller));
      controller.abort();
      const second = new AbortController();
      const restarted = await startZaloListener(params(profile, second));
      expect(api.listener.start).toHaveBeenCalledTimes(2);
      restarted.stop();
      expect(api.listener.stop).toHaveBeenCalledTimes(2);
    });
  });
  it("Z10 aborting one profile does not stop another profile", async () => {
    await withProfile(async (profile, api, controller) => {
      const other = `${profile}-other`;
      saveStoredZaloCredentials(
        other,
        {
          imei: "device",
          userAgent: "agent",
          createdAt: "2026-04-01T00:00:00.000Z",
          cookie: [{ key: "zpsid", value: "session", domain: "chat.zalo.me" }],
        },
        { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR! },
      );
      const otherApi = makeApi();
      createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => otherApi.api) });
      await startZaloListener(params(profile, controller));
      const otherController = new AbortController();
      const otherStarted = await startZaloListener(params(other, otherController));
      controller.abort();
      expect(api.listener.stop).toHaveBeenCalledTimes(1);
      expect(otherApi.listener.stop).not.toHaveBeenCalled();
      otherStarted.stop();
    });
  });
});
