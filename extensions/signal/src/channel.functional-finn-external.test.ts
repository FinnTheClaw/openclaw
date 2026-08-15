import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../src/auto-reply/reply-payload.js";
import { runReplyPayloadSendingHook } from "../../../src/auto-reply/reply/reply-payload-sending-hook.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../src/plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../../../src/plugins/hooks.test-helpers.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpc(...args),
}));

const { signalMessageAdapter } = await import("./channel.js");

const fixture = JSON.parse(
  readFileSync("test/fixtures/functional-finn-release-ipc.json", "utf8"),
) as { candidate: Record<string, unknown>; candidateDigest: string };
const servers: net.Server[] = [];
const directories: string[] = [];

async function authority() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-channel-"));
  directories.push(directory);
  const socketPath = path.join(directory, "release.sock");
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")),
    );
    socket.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).subarray(4).toString("utf8")) as Record<
        string,
        unknown
      >;
      requests.push(request);
      const body = Buffer.from(
        JSON.stringify({
          candidateId: request.candidateId,
          frameId: "frame-1",
          messageId: "signal-message-1",
          requestId: request.requestId,
          schema: "functional-finn.release-ipc.v1",
          status: "delivered",
        }),
      );
      const response = Buffer.allocUnsafe(body.length + 4);
      response.writeUInt32BE(body.length, 0);
      body.copy(response, 4);
      socket.end(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { requests, socketPath };
}

function config(socketPath: string) {
  return {
    channels: {
      signal: {
        accounts: {
          finn: {
            functionalFinnExternalAuthority: {
              enabled: true,
              agentId: "finn",
              candidateSocketPath: socketPath,
              ingressSocketPath: "/private/run/finnsig-ingress.sock",
              timeoutMs: 200,
              protectedTransport: true,
            },
          },
        },
      },
    },
  } as never;
}

function escrow() {
  return {
    functionalFinnExternalEscrow: {
      kind: "external_release_escrow",
      candidate: fixture.candidate,
      candidateDigest: fixture.candidateDigest,
    },
  };
}

function payloadContext(
  socketPath: string,
  channelData?: Record<string, unknown>,
  text = "Observed fact.",
) {
  return {
    cfg: config(socketPath),
    to: "+15550002222",
    text,
    accountId: "finn",
    payload: { text, channelData },
  } as never;
}

afterEach(async () => {
  vi.useRealTimers();
  resetGlobalHookRunner();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  rpc.mockReset();
});

function installReplyPayloadSendingHook(params: {
  handler: () => Promise<void>;
  timeoutMs?: number;
}) {
  resetGlobalHookRunner();
  const registry = createMockPluginRegistry([]);
  addTestHook({
    registry,
    pluginId: "functional-finn-hook-proof",
    hookName: "reply_payload_sending",
    handler: params.handler,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  });
  initializeGlobalHookRunner(registry);
}

async function runInstalledReplyPayloadHook(payload: ReplyPayload) {
  return await runReplyPayloadSendingHook({
    payload,
    kind: "final",
    channel: "signal",
    sessionKey: "agent:finn:signal:source-1",
    runId: "run-hook-proof",
    context: {
      channelId: "signal",
      accountId: "finn",
      conversationId: "source-1",
      sessionKey: "agent:finn:signal:source-1",
      runId: "run-hook-proof",
    },
  });
}

describe("Signal channel adapter Functional Finn external authority", () => {
  it("forwards payload escrow and releases exactly once without direct Signal RPC", async () => {
    const service = await authority();
    await expect(
      signalMessageAdapter.send?.payload?.(payloadContext(service.socketPath, escrow())),
    ).resolves.toMatchObject({ messageId: "signal-message-1" });
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      op: "candidate.release",
      message: "Observed fact.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    "before_agent_finalize timeout",
    "before_agent_finalize failure",
    "reply_payload_sending timeout",
    "reply_payload_sending failure",
  ])("fails closed after %s when no escrow is attached", async () => {
    const service = await authority();
    await expect(
      signalMessageAdapter.send?.payload?.(payloadContext(service.socketPath)),
    ).rejects.toThrow(/exact validated.*escrow/i);
    expect(service.requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed after the real fail-open reply hook runner catches an error", async () => {
    const service = await authority();
    installReplyPayloadSendingHook({
      handler: async () => {
        throw new Error("hook failed");
      },
    });
    const original = { text: "Observed fact." } satisfies ReplyPayload;
    const unchanged = await runInstalledReplyPayloadHook(original);
    expect(unchanged).toEqual(original);
    await expect(
      signalMessageAdapter.send?.payload?.(
        payloadContext(service.socketPath, unchanged?.channelData, unchanged?.text),
      ),
    ).rejects.toThrow(/exact validated.*escrow/i);
    expect(service.requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed after the real fail-open reply hook runner times out", async () => {
    const service = await authority();
    vi.useFakeTimers();
    installReplyPayloadSendingHook({
      handler: async () =>
        await new Promise<void>(() => {
          // Deliberately unresolved so the production hook timeout wins.
        }),
      timeoutMs: 10,
    });
    const original = { text: "Observed fact." } satisfies ReplyPayload;
    const pending = runInstalledReplyPayloadHook(original);
    await vi.advanceTimersByTimeAsync(10);
    const unchanged = await pending;
    expect(unchanged).toEqual(original);
    await expect(
      signalMessageAdapter.send?.payload?.(
        payloadContext(service.socketPath, unchanged?.channelData, unchanged?.text),
      ),
    ).rejects.toThrow(/exact validated.*escrow/i);
    expect(service.requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects post-hook payload mutation before release or direct Signal RPC", async () => {
    const service = await authority();
    await expect(
      signalMessageAdapter.send?.payload?.(
        payloadContext(service.socketPath, escrow(), "Changed after validation."),
      ),
    ).rejects.toThrow(/exact validated.*escrow/i);
    expect(service.requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hard-fails protected text and media sends without payload escrow", async () => {
    const service = await authority();
    await expect(
      signalMessageAdapter.send?.text?.({
        cfg: config(service.socketPath),
        to: "+15550002222",
        text: "Observed fact.",
        accountId: "finn",
      }),
    ).rejects.toThrow(/exact validated.*escrow/i);
    await expect(
      signalMessageAdapter.send?.media?.({
        cfg: config(service.socketPath),
        to: "+15550002222",
        text: "Observed fact.",
        mediaUrl: "file:///tmp/not-sent",
        accountId: "finn",
      }),
    ).rejects.toThrow(/text payloads only/i);
    expect(service.requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});
