import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendProtectedFunctionalFinnSignal } from "./functional-finn-external-send.js";

const fixture = JSON.parse(
  readFileSync("test/fixtures/functional-finn-release-ipc.json", "utf8"),
) as { candidate: Record<string, unknown>; candidateDigest: string };
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const directories: string[] = [];

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

async function authority(status: "delivered" | "unknown" | "denied", hang = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-send-"));
  directories.push(directory);
  const socketPath = path.join(directory, "release.sock");
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")),
    );
    socket.on("end", () => {
      const packet = Buffer.concat(chunks);
      const request = JSON.parse(packet.subarray(4).toString("utf8")) as Record<string, unknown>;
      requests.push(request);
      if (hang) {
        return;
      }
      const body = Buffer.from(
        JSON.stringify({
          candidateId: request.candidateId,
          frameId: status === "delivered" ? "frame-1" : null,
          messageId: status === "delivered" ? "signal-message-1" : null,
          requestId: request.requestId,
          schema: "functional-finn.release-ipc.v1",
          status,
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
  return { socketPath, requests };
}

function channelData(candidate = fixture.candidate, digest = fixture.candidateDigest) {
  return {
    functionalFinnExternalEscrow: {
      kind: "external_release_escrow",
      candidate,
      candidateDigest: digest,
    },
  };
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
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
  vi.restoreAllMocks();
});

describe("protected Functional Finn Signal adapter", () => {
  it("releases the exact escrow and returns the external message receipt", async () => {
    const service = await authority("delivered");
    const result = await sendProtectedFunctionalFinnSignal({
      cfg: config(service.socketPath),
      accountId: "finn",
      text: "Observed fact.",
      channelData: channelData(),
    });
    expect(result.messageId).toBe("signal-message-1");
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      op: "candidate.release",
      message: "Observed fact.",
    });
    expect(service.requests[0]).not.toHaveProperty("destination");
  });

  it.each([
    ["missing escrow", undefined, "Observed fact."],
    ["altered payload", channelData(), "Changed after validation."],
    ["altered digest", channelData(fixture.candidate, "0".repeat(64)), "Observed fact."],
  ])("fails closed for %s before authority release", async (_label, data, text) => {
    const service = await authority("delivered");
    await expect(
      sendProtectedFunctionalFinnSignal({
        cfg: config(service.socketPath),
        accountId: "finn",
        text,
        channelData: data,
      }),
    ).rejects.toThrow(/exact validated|escrow/);
    expect(service.requests).toHaveLength(0);
  });

  it.each(["unknown", "denied"] as const)("fails closed on terminal %s", async (status) => {
    const service = await authority(status);
    await expect(
      sendProtectedFunctionalFinnSignal({
        cfg: config(service.socketPath),
        accountId: "finn",
        text: "Observed fact.",
        channelData: channelData(),
      }),
    ).rejects.toThrow(status);
    expect(service.requests).toHaveLength(1);
  });

  it("fails closed when the external authority times out", async () => {
    const service = await authority("delivered", true);
    await expect(
      sendProtectedFunctionalFinnSignal({
        cfg: config(service.socketPath),
        accountId: "finn",
        text: "Observed fact.",
        channelData: channelData(),
      }),
    ).rejects.toThrow(/timed out/);
    expect(service.requests).toHaveLength(1);
  });

  it("contains no direct Signal RPC or daemon dependency", () => {
    const source = readFileSync("extensions/signal/src/functional-finn-external-send.ts", "utf8");
    expect(source).not.toMatch(/client-adapter|signalRpcRequest|spawnSignalDaemon|signal-cli/);
  });
});
