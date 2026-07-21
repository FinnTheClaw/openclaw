// Signal tests cover monitor.tool result.pairs uuid only senders uuid allowlist entry plugin behavior.
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  config,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";
import { setSignalRuntime } from "./runtime.js";
import { clearSignalRuntimeForTest } from "./runtime.test-support.js";
import { createSignalIngressEventId, type SignalIngressPayload } from "./signal-ingress-queue.js";

installSignalToolResultTestHooks();
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, streamMock, signalRpcRequestMock, upsertPairingRequestMock } =
  getSignalToolResultTestMocks();

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call.at(argIndex);
}

describe("monitorSignalProvider tool results", () => {
  it("persists every received event before an immediate monitor shutdown", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-monitor-ingress-"));
    const queue = createChannelIngressQueue<SignalIngressPayload>({
      channelId: "signal",
      accountId: "default",
      stateDir,
    });
    setSignalRuntime(
      createPluginRuntimeMock({
        state: {
          resolveStateDir: () => stateDir,
          openChannelIngressQueue: (options = {}) =>
            createChannelIngressQueue({ ...options, channelId: "signal" }),
        },
      }),
    );
    const baseChannels = (config.channels ?? {}) as Record<string, unknown>;
    setSignalToolResultTestConfig({
      ...config,
      channels: {
        ...baseChannels,
        signal: {
          ...((baseChannels.signal ?? {}) as Record<string, unknown>),
          durableIngress: true,
        },
      },
    });
    const abortController = new AbortController();
    const events = ["one", "two", "three"].map((event) => ({ event, data: "{}" }));
    streamMock.mockImplementation(async ({ onEvent }) => {
      for (const event of events) {
        onEvent(event);
      }
      abortController.abort(new Error("simulated gateway shutdown"));
    });

    try {
      await runMonitorWithMocks({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });
      const redeliveryKinds: string[] = [];
      for (const event of events) {
        const result = await queue.enqueue(createSignalIngressEventId(event), {
          version: 1,
          event,
          receivedAt: 1,
        });
        redeliveryKinds.push(result.kind);
      }
      expect(redeliveryKinds).not.toContain("accepted");
      expect(redeliveryKinds).toHaveLength(3);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      clearSignalRuntimeForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes five real Signal messages through one durable working claim", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-monitor-burst-"));
    const queue = createChannelIngressQueue<SignalIngressPayload>({
      channelId: "signal",
      accountId: "default",
      stateDir,
    });
    setSignalRuntime(
      createPluginRuntimeMock({
        state: {
          resolveStateDir: () => stateDir,
          openChannelIngressQueue: (options = {}) =>
            createChannelIngressQueue({ ...options, channelId: "signal" }),
        },
      }),
    );
    setSignalToolResultTestConfig({
      channels: {
        signal: {
          autoStart: false,
          durableIngress: true,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    const abortController = new AbortController();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observedBodies: string[] = [];
    replyMock.mockImplementation(async (ctx: unknown) => {
      const body = (ctx as { Body?: unknown }).Body;
      observedBodies.push(typeof body === "string" ? body : "");
      if (observedBodies.length === 1) {
        await firstBlocked;
      }
      return { text: `reply-${observedBodies.length}` };
    });
    const messages = ["one", "two", "three", "four", "five"];

    streamMock.mockImplementation(async ({ onEvent }) => {
      for (const [index, message] of messages.entries()) {
        onEvent({
          event: "receive",
          data: JSON.stringify({
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp: index + 1,
              dataMessage: { message },
            },
          }),
        });
      }
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(1);
        expect(await queue.listPending({ limit: "all" })).toHaveLength(4);
      });
      const liveRecords = [
        ...(await queue.listClaims()),
        ...(await queue.listPending({ limit: "all" })),
      ];
      expect(new Set(liveRecords.map((record) => record.laneKey)).size).toBe(1);
      expect(liveRecords[0]?.laneKey).toBeTruthy();

      releaseFirst();
      await vi.waitFor(() => expect(replyMock).toHaveBeenCalledTimes(5));
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      });
      abortController.abort(new Error("burst test complete"));
    });

    try {
      await runMonitorWithMocks({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });
      expect(observedBodies.map((body) => body.split(": ").at(-1))).toEqual(messages);
      expect(sendMock).toHaveBeenCalledTimes(5);
    } finally {
      clearSignalRuntimeForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("pairs uuid-only senders with a uuid allowlist entry", async () => {
    const baseChannels = (config.channels ?? {}) as Record<string, unknown>;
    const baseSignal = (baseChannels.signal ?? {}) as Record<string, unknown>;
    setSignalToolResultTestConfig({
      ...config,
      channels: {
        ...baseChannels,
        signal: {
          ...baseSignal,
          autoStart: false,
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });
    const abortController = new AbortController();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceUuid: uuid,
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await runMonitorWithMocks({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "signal",
      id: `uuid:${uuid}`,
      accountId: "default",
      meta: { name: "Ada" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(sendMock)).toBe(`signal:${uuid}`);
    const pairingReply = mockCallArg(sendMock, 0, 1);
    if (typeof pairingReply !== "string") {
      throw new Error("Expected pairing reply text");
    }
    expect(pairingReply).toContain(`Your Signal sender id: uuid:${uuid}`);
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;

    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stream dropped");
      }
      abortController.abort();
    });

    try {
      const monitorPromise = monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
        reconnectPolicy: {
          initialMs: 1,
          maxMs: 1,
          factor: 1,
          jitter: 0,
        },
      });

      await vi.advanceTimersByTimeAsync(5);
      await monitorPromise;

      expect(streamMock).toHaveBeenCalledTimes(2);
      expect((mockCallArg(streamMock) as { timeoutMs?: unknown }).timeoutMs).toBe(0);
      expect((mockCallArg(streamMock, 1) as { timeoutMs?: unknown }).timeoutMs).toBe(0);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels a pending reply-session conflict retry when the monitor stops", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    replyMock.mockRejectedValue(
      new Error(
        "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
      ),
    );
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "hello after the prior turn" },
          },
        }),
      });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    try {
      const monitorPromise = monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });

      await vi.waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
      abortController.abort(new Error("monitor stopped"));
      await monitorPromise;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(replyMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an inline inbound message accepted before the monitor stops", async () => {
    const abortController = new AbortController();
    setSignalToolResultTestConfig({
      channels: {
        signal: {
          autoStart: false,
          durableIngress: false,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    replyMock.mockResolvedValue({ text: "accepted reply" });
    streamMock.mockImplementation(async ({ onEvent }) => {
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "accepted message" },
          },
        }),
      });
      abortController.abort(new Error("monitor stopped"));
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("+15550001111", "accepted reply", expect.anything());
  });

  it("does not dispatch a buffered inbound message after the monitor stops", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    setSignalToolResultTestConfig({
      messages: { inbound: { debounceMs: 10 } },
      channels: {
        signal: {
          autoStart: false,
          durableIngress: false,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    replyMock.mockResolvedValue({ text: "late reply" });
    streamMock.mockImplementation(async ({ onEvent }) => {
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "wait for more" },
          },
        }),
      });
      abortController.abort(new Error("monitor stopped"));
    });

    try {
      await monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(replyMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes attachment RPC response caps from mediaMaxMb", async () => {
    const abortController = new AbortController();
    const maxBytes = 2 * 1024 * 1024;
    const expectedMaxResponseBytes = Math.ceil((maxBytes * 4) / 3) + 64 * 1024;

    replyMock.mockResolvedValue({ text: "ok" });
    signalRpcRequestMock.mockResolvedValue({ data: Buffer.from("hello").toString("base64") });
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "",
              attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
            },
          },
        }),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      mediaMaxMb: 2,
      abortSignal: abortController.signal,
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "getAttachment",
      {
        id: "attachment-1",
        recipient: "+15550001111",
      },
      {
        baseUrl: "http://127.0.0.1:8080",
        timeoutMs: undefined,
        apiMode: "auto",
        maxResponseBytes: expectedMaxResponseBytes,
      },
    );
  });
});
