import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestFunctionalFinnVerifier } from "./verifier-client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function serve(handler: (socket: net.Socket, request: string) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-verifier-"));
  const socketPath = path.join(directory, "server.sock");
  const clients = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => handler(socket, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const client of clients) {
      client.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await fs.rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

const request = {
  operation: "verify_memory" as const,
  agentId: "finn",
  claim: "Service is healthy",
  evidence: {
    evidenceId: "e",
    agentId: "finn",
    content: "healthy",
    observedAt: 1,
    freshnessUntil: 2,
    sourceKind: "user_confirmed" as const,
    state: "current" as const,
  },
  sourceStartByte: 0,
  sourceEndByte: 7,
  sourceQuote: "healthy",
};

describe("Functional Finn verifier client", () => {
  it("exchanges one bounded JSON frame", async () => {
    const socketPath = await serve((socket, raw) => {
      expect(JSON.parse(raw).operation).toBe("verify_memory");
      socket.end('{"ok":true}\n');
    });
    await expect(
      requestFunctionalFinnVerifier({ socketPath, timeoutMs: 500, request }),
    ).resolves.toEqual({ ok: true });
  });

  it("fails closed on timeout", async () => {
    const socketPath = await serve(() => undefined);
    await expect(
      requestFunctionalFinnVerifier({ socketPath, timeoutMs: 100, request }),
    ).rejects.toThrow("timed out");
  });

  it("rejects an oversized verifier response before parsing", async () => {
    const socketPath = await serve((socket) => socket.end("x".repeat(256 * 1024 + 1)));
    await expect(
      requestFunctionalFinnVerifier({ socketPath, timeoutMs: 500, request }),
    ).rejects.toThrow("oversized");
  });
});
