import type { Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  servers: [] as Server[],
  steps: [] as string[],
  webhookStops: 0,
  webhookStopError: undefined as unknown,
  managerInitialize: vi.fn(),
  startTunnel: vi.fn(),
  tunnelStop: vi.fn(),
  cleanupTailscaleExposure: vi.fn(),
  setupTailscaleExposure: vi.fn(),
}));

vi.mock("./manager.js", () => ({
  CallManager: class {
    initialize = mocks.managerInitialize;
  },
}));

vi.mock("./tunnel.js", () => ({ startTunnel: mocks.startTunnel }));
vi.mock("./webhook/tailscale.js", () => ({
  cleanupTailscaleExposure: mocks.cleanupTailscaleExposure,
  setupTailscaleExposure: mocks.setupTailscaleExposure,
}));

// The dependency is controlled, but its listener is a real ephemeral HTTP socket.
vi.mock("./webhook.js", async () => {
  const { createServer } = await import("node:http");
  return {
    VoiceCallWebhookServer: class {
      private readonly server = createServer((_request, response) => response.end("ok"));

      async start(): Promise<string> {
        mocks.servers.push(this.server);
        return await new Promise<string>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          this.server.once("error", onError);
          this.server.listen(0, "127.0.0.1", () => {
            this.server.off("error", onError);
            const address = this.server.address();
            if (!address || typeof address === "string") {
              reject(new Error("missing loopback listener address"));
              return;
            }
            resolve(`http://127.0.0.1:${address.port}/voice/webhook`);
          });
        });
      }

      async stop(): Promise<void> {
        mocks.steps.push("webhook");
        mocks.webhookStops += 1;
        if (mocks.webhookStopError) {
          throw mocks.webhookStopError;
        }
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      getRealtimeHandler() {
        return undefined;
      }
    },
  };
});

import { createVoiceCallRuntime } from "./runtime.js";

async function createRuntime(withTunnel = true) {
  const config = createVoiceCallBaseConfig({
    tunnelProvider: withTunnel ? "ngrok" : "none",
  });
  config.agentId = "main";
  return await createVoiceCallRuntime({
    config,
    coreConfig: {} as OpenClawConfig,
    agentRuntime: {} as never,
  });
}

function listener(): Server {
  const server = mocks.servers.at(-1);
  if (!server) {
    throw new Error("expected real loopback listener");
  }
  return server;
}

describe("voice runtime cleanup checkpoint 100", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.servers.length = 0;
    mocks.steps.length = 0;
    mocks.webhookStops = 0;
    mocks.webhookStopError = undefined;
    mocks.managerInitialize.mockResolvedValue(undefined);
    mocks.tunnelStop.mockImplementation(async () => {
      mocks.steps.push("tunnel");
    });
    mocks.startTunnel.mockImplementation(async () => ({
      publicUrl: "https://voice.example.test/voice/webhook",
      provider: "ngrok",
      stop: mocks.tunnelStop,
    }));
    mocks.cleanupTailscaleExposure.mockImplementation(async () => {
      mocks.steps.push("exposure");
    });
    mocks.setupTailscaleExposure.mockResolvedValue(null);
  });

  afterEach(async () => {
    // A pre-fix failure must not leak the intentionally real test listener.
    for (const server of mocks.servers) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    mocks.servers.length = 0;
  });

  it("CP100-VOICE01 normal stop performs each cleanup once in order", async () => {
    const runtime = await createRuntime();
    expect(listener().listening).toBe(true);
    await runtime.stop();
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(listener().listening).toBe(false);
    expect(mocks.webhookStops).toBe(1);
  });

  it("CP100-VOICE02 tunnel rejection still closes the webhook listener", async () => {
    const failure = new Error("tunnel stop failed");
    mocks.tunnelStop.mockImplementation(async () => {
      mocks.steps.push("tunnel");
      throw failure;
    });
    const runtime = await createRuntime();
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(listener().listening).toBe(false);
  });

  it("CP100-VOICE03 exposure rejection still closes the webhook listener", async () => {
    const failure = new Error("exposure cleanup failed");
    mocks.cleanupTailscaleExposure.mockImplementation(async () => {
      mocks.steps.push("exposure");
      throw failure;
    });
    const runtime = await createRuntime();
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(listener().listening).toBe(false);
  });

  it("CP100-VOICE04 webhook stop failure propagates after earlier cleanup", async () => {
    const failure = new Error("webhook stop failed");
    mocks.webhookStopError = failure;
    const runtime = await createRuntime();
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(listener().listening).toBe(true);
  });

  it("CP100-VOICE05 all three failures are attempted and the first wins", async () => {
    const first = new Error("first tunnel failure");
    mocks.tunnelStop.mockImplementation(async () => {
      mocks.steps.push("tunnel");
      throw first;
    });
    mocks.cleanupTailscaleExposure.mockImplementation(async () => {
      mocks.steps.push("exposure");
      throw new Error("second exposure failure");
    });
    mocks.webhookStopError = new Error("third webhook failure");
    const runtime = await createRuntime();
    await expect(runtime.stop()).rejects.toBe(first);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(mocks.webhookStops).toBe(1);
  });

  it("CP100-VOICE06 no tunnel plus exposure failure still closes listener", async () => {
    const failure = new Error("exposure failure without tunnel");
    mocks.cleanupTailscaleExposure.mockImplementation(async () => {
      mocks.steps.push("exposure");
      throw failure;
    });
    const runtime = await createRuntime(false);
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
    expect(mocks.steps).toEqual(["exposure", "webhook"]);
    expect(listener().listening).toBe(false);
  });

  it("CP100-VOICE07 startup retains initialize error despite rollback failures", async () => {
    const initializeError = new Error("initialize failed");
    mocks.managerInitialize.mockRejectedValue(initializeError);
    mocks.tunnelStop.mockImplementation(async () => {
      mocks.steps.push("tunnel");
      throw new Error("rollback tunnel failed");
    });
    mocks.cleanupTailscaleExposure.mockImplementation(async () => {
      mocks.steps.push("exposure");
      throw new Error("rollback exposure failed");
    });
    mocks.webhookStopError = new Error("rollback webhook failed");
    await expect(createRuntime()).rejects.toBe(initializeError);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(mocks.webhookStops).toBe(1);
  });

  it("CP100-VOICE08 concurrent stops share a promise and one cleanup", async () => {
    let releaseTunnel: (() => void) | undefined;
    mocks.tunnelStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          mocks.steps.push("tunnel");
          releaseTunnel = resolve;
        }),
    );
    const runtime = await createRuntime();
    const first = runtime.stop();
    const second = runtime.stop();
    try {
      expect(second).toBe(first);
      expect(mocks.steps).toEqual(["tunnel"]);
    } finally {
      releaseTunnel?.();
    }
    await first;
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(mocks.webhookStops).toBe(1);
    expect(listener().listening).toBe(false);
  });

  it("CP100-VOICE09 failed stop remains memoized without duplicate cleanup", async () => {
    const failure = new Error("memoized tunnel failure");
    mocks.tunnelStop.mockImplementation(async () => {
      mocks.steps.push("tunnel");
      throw failure;
    });
    const runtime = await createRuntime();
    const first = runtime.stop();
    await expect(first).rejects.toBe(failure);
    const second = runtime.stop();
    expect(second).toBe(first);
    await expect(second).rejects.toBe(failure);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(mocks.webhookStops).toBe(1);
    expect(listener().listening).toBe(false);
  });

  it("CP100-VOICE10 synchronous tunnel throw still closes listener", async () => {
    const failure = new Error("synchronous tunnel failure");
    mocks.tunnelStop.mockImplementation(() => {
      mocks.steps.push("tunnel");
      throw failure;
    });
    const runtime = await createRuntime();
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(mocks.steps).toEqual(["tunnel", "exposure", "webhook"]);
    expect(listener().listening).toBe(false);
  });
});
