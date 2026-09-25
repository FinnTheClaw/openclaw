import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const cookie = "urbauth-~zod=synthetic-stop-race";
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
const servers: Server[] = [];
const clients: UrbitSSEClient[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the real loopback request");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settlesPromptly(promise: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(
      await Promise.race([
        promise.then(() => "settled" as const),
        new Promise<"timed out">((resolve) => {
          timeout = setTimeout(() => resolve("timed out"), 250);
        }),
      ]),
    ).toBe("settled");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function startServer(getStatuses: number[] = []) {
  const requests: string[] = [];
  const putBodies: string[] = [];
  const heldStreams = new Set<ServerResponse>();
  let getCount = 0;
  const server = createServer((request, response) => {
    if (!(request.headers.cookie ?? "").includes(cookie)) {
      response.writeHead(401).end();
      return;
    }
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.method === "GET") {
      const status = getStatuses[getCount++] ?? 200;
      if (status !== 200) {
        response.writeHead(status).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      heldStreams.add(response);
      response.once("close", () => heldStreams.delete(response));
      response.write(": connected\n\n");
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        putBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204).end();
      });
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    putBodies,
    getCount: () => getCount,
    heldStreams,
  };
}

function newClient(
  baseUrl: string,
  options: ConstructorParameters<typeof UrbitSSEClient>[2] = {},
): UrbitSSEClient {
  const client = new UrbitSSEClient(baseUrl, cookie, {
    ship: "zod",
    ssrfPolicy: { allowPrivateNetwork: true },
    lookupFn: lookupLoopback,
    reconnectDelay: 1,
    ...options,
  });
  clients.push(client);
  return client;
}

function gateFetch(method: string, ordinal = 1) {
  const entered = deferred<void>();
  const release = deferred<void>();
  let count = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    // The HTTP response is real; only its delivery to the client is gated.
    const response = await fetch(input, init);
    if ((init?.method ?? "GET") === method && ++count === ordinal) {
      entered.resolve();
      await release.promise;
    }
    return response;
  };
  return { entered: entered.promise, release: () => release.resolve(), fetchImpl };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stopReceiving();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("UrbitSSEClient stop during reconnect await edges", () => {
  it("F08-C01 stops during ordinary backoff without fetching", async () => {
    const proof = await startServer();
    const client = newClient(proof.baseUrl, { reconnectDelay: 400 });
    const attempt = client.attemptReconnect();
    client.stopReceiving();
    await settlesPromptly(attempt);
    expect(proof.requests).toHaveLength(0);
    expect(client.isConnected).toBe(false);
  });

  it("F08-C02 stops during the ten-second retry cooldown", async () => {
    const proof = await startServer();
    const client = newClient(proof.baseUrl, { maxReconnectAttempts: 1 });
    client.reconnectAttempts = client.maxReconnectAttempts;
    const attempt = client.attemptReconnect();
    client.stopReceiving();
    await settlesPromptly(attempt);
    expect(proof.requests).toHaveLength(0);
    expect(client.reconnectAttempts).toBe(1);
  });

  it("F08-C03 stops while authentication callback is pending", async () => {
    const proof = await startServer();
    const entered = deferred<void>();
    const release = deferred<void>();
    const client = newClient(proof.baseUrl, {
      onReconnect: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const attempt = client.attemptReconnect();
    await entered.promise;
    client.stopReceiving();
    release.resolve();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(0);
    expect(client.isConnected).toBe(false);
  });

  it("F08-C04 drops a late successful first GET response after stop", async () => {
    const proof = await startServer();
    const gate = gateFetch("GET");
    const client = newClient(proof.baseUrl, { fetchImpl: gate.fetchImpl });
    const attempt = client.attemptReconnect();
    await gate.entered;
    client.stopReceiving();
    gate.release();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(1);
    expect(client.isConnected).toBe(false);
    expect(client.streamController).toBeNull();
    expect(client.streamRelease).toBeNull();
    await waitFor(() => proof.heldStreams.size === 0);
  });

  it("F08-C05 does not recreate a channel from a late 404 after stop", async () => {
    const proof = await startServer([404]);
    const gate = gateFetch("GET");
    const client = newClient(proof.baseUrl, { fetchImpl: gate.fetchImpl });
    const channelId = client.channelId;
    const attempt = client.attemptReconnect();
    await gate.entered;
    client.stopReceiving();
    gate.release();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(1);
    expect(client.channelId).toBe(channelId);
    expect(proof.requests.filter((request) => request.startsWith("PUT "))).toHaveLength(0);
    expect(client.isConnected).toBe(false);
  });

  it("F08-C06 does not issue a second GET after stop during channel recreation", async () => {
    const proof = await startServer([404]);
    const gate = gateFetch("PUT");
    const client = newClient(proof.baseUrl, { fetchImpl: gate.fetchImpl });
    const attempt = client.attemptReconnect();
    await gate.entered;
    client.stopReceiving();
    gate.release();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(1);
    expect(proof.requests.filter((request) => request.startsWith("PUT "))).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });

  it("F08-C07 drops a late successful second GET after channel recreation", async () => {
    const proof = await startServer([404, 200]);
    const gate = gateFetch("GET", 2);
    const client = newClient(proof.baseUrl, { fetchImpl: gate.fetchImpl });
    const attempt = client.attemptReconnect();
    await gate.entered;
    client.stopReceiving();
    gate.release();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(2);
    expect(client.isConnected).toBe(false);
    expect(client.streamRelease).toBeNull();
    await waitFor(() => proof.heldStreams.size === 0);
  });

  it("F08-C08 reconnects normally on the same channel", async () => {
    const proof = await startServer();
    const client = newClient(proof.baseUrl);
    const channelId = client.channelId;
    await client.attemptReconnect();
    expect(proof.getCount()).toBe(1);
    expect(client.channelId).toBe(channelId);
    expect(client.isConnected).toBe(true);
    client.stopReceiving();
  });

  it("F08-C09 recreates a genuinely missing channel and reconnects", async () => {
    const proof = await startServer([404, 200]);
    const client = newClient(proof.baseUrl);
    const channelId = client.channelId;
    await client.subscribe({ app: "chat", path: "/foo" });
    await client.attemptReconnect();
    expect(proof.getCount()).toBe(2);
    expect(proof.requests.filter((request) => request.startsWith("PUT "))).toHaveLength(1);
    expect(JSON.parse(proof.putBodies[0] ?? "null")).toEqual([
      { id: 1, action: "subscribe", ship: "zod", app: "chat", path: "/foo" },
    ]);
    expect(client.channelId).not.toBe(channelId);
    expect(client.isConnected).toBe(true);
    client.stopReceiving();
  });

  it("F08-C10 public close during authentication prevents a post-close GET", async () => {
    const proof = await startServer();
    const entered = deferred<void>();
    const release = deferred<void>();
    const client = newClient(proof.baseUrl, {
      onReconnect: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const attempt = client.attemptReconnect();
    await entered.promise;
    await client.close();
    release.resolve();
    await settlesPromptly(attempt);
    expect(proof.getCount()).toBe(0);
    expect(proof.requests.some((request) => request.startsWith("DELETE "))).toBe(true);
    expect(client.isConnected).toBe(false);
  });
});
