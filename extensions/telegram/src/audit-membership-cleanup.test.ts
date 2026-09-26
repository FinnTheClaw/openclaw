import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { auditTelegramGroupMembership } from "./audit.js";

type Reply = (req: IncomingMessage, res: ServerResponse) => void;
type Fixture = { apiRoot: string; requests: string[]; sockets: Set<Socket> };
const response = (res: ServerResponse, value: unknown, status = 200) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};
const membership = (status: string) => ({ ok: true, result: { status } });
async function withApi(reply: Reply, check: (fixture: Fixture) => Promise<void>): Promise<void> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    reply(req, res);
  });
  server.keepAliveTimeout = 10_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await check({
      apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      requests,
      sockets,
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const audit = (fixture: Fixture, groupIds: string[], timeoutMs = 800) =>
  auditTelegramGroupMembership({
    token: "controlled-test-token",
    botId: 77,
    groupIds,
    timeoutMs,
    apiRoot: fixture.apiRoot,
  });
async function settled(fixture: Fixture): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (fixture.sockets.size && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fixture.sockets.size).toBe(0);
}
const chat = (req: IncomingMessage) =>
  new URL(req.url ?? "/", "http://localhost").searchParams.get("chat_id");

describe("Telegram membership audit owned transport cleanup (real loopback HTTP)", () => {
  it("CP60-TG01 member success", async () => {
    await withApi(
      (_req, res) => response(res, membership("member")),
      async (fixture) => {
        const result = await audit(fixture, ["-1001"]);
        expect(result.groups.map((group) => group.ok)).toEqual([true]);
        expect(fixture.requests).toHaveLength(1);
        await settled(fixture);
      },
    );
  });
  it("CP60-TG02 administrator and creator neighbors", async () => {
    await withApi(
      (req, res) => response(res, membership(chat(req) === "-1002" ? "administrator" : "creator")),
      async (fixture) => {
        const result = await audit(fixture, ["-1002", "-1003"]);
        expect(result.groups.map((group) => group.ok)).toEqual([true, true]);
        expect(fixture.requests).toHaveLength(2);
        await settled(fixture);
      },
    );
  });
  it("CP60-TG03 mixed multiple groups", async () => {
    await withApi(
      (req, res) => response(res, membership(chat(req) === "-1004" ? "member" : "left")),
      async (fixture) => {
        const result = await audit(fixture, ["-1004", "-1005", "-1006"]);
        expect(result.groups.map((group) => group.ok)).toEqual([true, false, false]);
        expect(fixture.requests).toHaveLength(3);
        await settled(fixture);
      },
    );
  });
  it("CP60-TG04 malformed JSON", async () => {
    await withApi(
      (_req, res) => {
        res.writeHead(200);
        res.end("{bad-json");
      },
      async (fixture) => {
        const result = await audit(fixture, ["-1007"]);
        expect(result.groups[0]?.ok).toBe(false);
        expect(result.groups[0]?.error).toBeTruthy();
        await settled(fixture);
      },
    );
  });
  it("CP60-TG05 HTTP and API errors", async () => {
    await withApi(
      (req, res) =>
        response(
          res,
          { ok: false, description: "controlled failure" },
          chat(req) === "-1008" ? 503 : 200,
        ),
      async (fixture) => {
        const result = await audit(fixture, ["-1008", "-1009"]);
        expect(result.groups.map((group) => group.ok)).toEqual([false, false]);
        expect(result.groups.every((group) => Boolean(group.error))).toBe(true);
        expect(fixture.requests).toHaveLength(2);
        await settled(fixture);
      },
    );
  });
  it("CP60-TG06 kicked nonmember", async () => {
    await withApi(
      (_req, res) => response(res, membership("kicked")),
      async (fixture) => {
        const result = await audit(fixture, ["-1010"]);
        expect(result.groups[0]?.ok).toBe(false);
        expect(result.groups[0]?.status).toBe("kicked");
        await settled(fixture);
      },
    );
  });
  it("CP60-TG07 stalled response body", async () => {
    await withApi(
      (_req, res) => {
        res.writeHead(200);
        res.write('{"ok":true,"result":');
      },
      async (fixture) => {
        const result = await audit(fixture, ["-1011"], 120);
        expect(result.groups[0]?.ok).toBe(false);
        expect(result.groups[0]?.error).toBeTruthy();
        await settled(fixture);
      },
    );
  });
  it("CP60-TG08 fetch-level connection reset", async () => {
    await withApi(
      (req) => req.socket.destroy(),
      async (fixture) => {
        const result = await audit(fixture, ["-1012"]);
        expect(result.groups[0]?.ok).toBe(false);
        expect(result.groups[0]?.error).toBeTruthy();
        expect(fixture.requests.length).toBeGreaterThan(0);
        await settled(fixture);
      },
    );
  });
  it("CP60-TG09 repeated finite audits settle after each call", async () => {
    await withApi(
      (_req, res) => response(res, membership("member")),
      async (fixture) => {
        for (let index = 0; index < 3; index += 1) {
          const result = await audit(fixture, ["-1013"]);
          expect(result.groups[0]?.ok).toBe(true);
          expect(fixture.requests).toHaveLength(index + 1);
          await settled(fixture);
        }
      },
    );
  });
  it("CP60-TG10 empty list makes no request and leaves no live socket", async () => {
    await withApi(
      (_req, res) => response(res, membership("member")),
      async (fixture) => {
        const result = await audit(fixture, []);
        expect(result.groups).toEqual([]);
        expect(fixture.requests).toEqual([]);
        await settled(fixture);
      },
    );
  });
});
