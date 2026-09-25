// Real loopback TCP coverage for bounded IRC inbound framing.
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { connectIrcClient } from "./client.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";

const MAX_INBOUND_LINE_BYTES = 8_703;

type FramingPeer = {
  socket: net.Socket;
  lines: string[];
  outgoing: string[];
  errors: Error[];
  messages: string[];
};

async function withFramingPeer(run: (peer: FramingPeer) => Promise<void>): Promise<void> {
  let acceptedSocket: net.Socket | undefined;
  const outgoing: string[] = [];
  const server = await startIrcTestServer((socket) => {
    acceptedSocket = socket;
    onIrcTestLine(socket, (line) => {
      outgoing.push(line);
      if (line.startsWith("USER ")) {
        socket.write(":server 001 bot :welcome\r\n");
      }
    });
  });
  const lines: string[] = [];
  const errors: Error[] = [];
  const messages: string[] = [];
  let client: Awaited<ReturnType<typeof connectIrcClient>> | undefined;
  try {
    client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "Framing test",
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
      onPrivmsg: (event) => {
        messages.push(event.text);
      },
    });
    if (!acceptedSocket) {
      throw new Error("loopback server did not accept IRC socket");
    }
    await run({ socket: acceptedSocket, lines, outgoing, errors, messages });
  } finally {
    client?.close();
    await server.close();
  }
}

function taggedPingLine(totalBytes: number, multibyte = false): string {
  const prefix = "@x=";
  const suffix = " PING :tag\r\n";
  const valueBytes = totalBytes - Buffer.byteLength(prefix + suffix, "utf8");
  if (valueBytes < 0) {
    throw new Error("tagged test line is too short");
  }
  const value = multibyte
    ? "é".repeat(Math.floor(valueBytes / 2)) + "a".repeat(valueBytes % 2)
    : "a".repeat(valueBytes);
  const line = prefix + value + suffix;
  if (Buffer.byteLength(line, "utf8") !== totalBytes) {
    throw new Error("tagged test line has the wrong byte length");
  }
  return line;
}

async function expectEventually(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 2_000 });
}

describe("IRC inbound framing loopback pack", () => {
  it("[IRC-01] responds to a normal CRLF PING", async () => {
    await withFramingPeer(async ({ socket, outgoing, errors }) => {
      socket.write("PING :plain\r\n");
      await expectEventually(() => expect(outgoing).toContain("PONG :plain"));
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-02] accepts an IRCv3 tagged line of exactly 8703 bytes including CRLF", async () => {
    await withFramingPeer(async ({ socket, outgoing, lines, errors }) => {
      const line = taggedPingLine(MAX_INBOUND_LINE_BYTES);
      socket.write(Buffer.from(line));
      await expectEventually(() => expect(lines).toContain(line.slice(0, -2)));
      expect(outgoing).not.toContain("PONG :tag");
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-03] rejects a completed line of 8704 bytes", async () => {
    await withFramingPeer(async ({ socket, lines, errors }) => {
      socket.write(Buffer.from(taggedPingLine(MAX_INBOUND_LINE_BYTES + 1)));
      await expectEventually(() => expect(errors[0]?.message).toMatch(/8703-byte limit/));
      expect(lines).not.toContain("PING :tag");
    });
  });

  it("[IRC-04] rejects an oversized unterminated tail", async () => {
    await withFramingPeer(async ({ socket, errors }) => {
      socket.write(Buffer.alloc(100_000, 0x61));
      await expectEventually(() => expect(errors[0]?.message).toMatch(/8703-byte limit/));
    });
  });

  it("[IRC-05] accepts many coalesced valid lines even when the chunk exceeds 8703 bytes", async () => {
    await withFramingPeer(async ({ socket, outgoing, errors }) => {
      const count = 1_000;
      const batch = Array.from({ length: count }, (_, index) => `PING :${index}\r\n`).join("");
      expect(Buffer.byteLength(batch, "utf8")).toBeGreaterThan(MAX_INBOUND_LINE_BYTES);
      socket.write(batch);
      await expectEventually(() =>
        expect(outgoing.filter((line) => line.startsWith("PONG :"))).toHaveLength(count),
      );
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-06] frames CR and LF split across TCP writes", async () => {
    await withFramingPeer(async ({ socket, outgoing, errors }) => {
      socket.write("PING :split\r");
      socket.write("\n");
      await expectEventually(() => expect(outgoing).toContain("PONG :split"));
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-07] accepts multibyte UTF-8 at the 8703-byte boundary", async () => {
    await withFramingPeer(async ({ socket, lines, errors }) => {
      const line = taggedPingLine(MAX_INBOUND_LINE_BYTES, true);
      socket.write(Buffer.from(line));
      await expectEventually(() => expect(lines).toContain(line.slice(0, -2)));
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-08] rejects multibyte UTF-8 one byte over the boundary", async () => {
    await withFramingPeer(async ({ socket, outgoing, errors }) => {
      socket.write(
        Buffer.from(taggedPingLine(MAX_INBOUND_LINE_BYTES + 1, true) + "PING :later\r\n"),
      );
      await expectEventually(() => expect(errors[0]?.message).toMatch(/8703-byte limit/));
      expect(outgoing).not.toContain("PONG :later");
    });
  });

  it("[IRC-09] preserves a tagged raw line without changing command parsing", async () => {
    await withFramingPeer(async ({ socket, lines, messages, errors }) => {
      const line = "@time=2026-09-24T00:00:00Z :alice!u@h PRIVMSG #room :hello\r\n";
      socket.write(line);
      await expectEventually(() => expect(lines).toContain(line.slice(0, -2)));
      expect(messages).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  it("[IRC-10] keeps CAP and multiline batch frames independent", async () => {
    await withFramingPeer(async ({ socket, lines, messages, errors }) => {
      socket.write(
        ":server CAP bot ACK :draft/multiline\r\n" +
          ":server BATCH +abc draft/multiline #room\r\n" +
          ":alice!u@h PRIVMSG #room :one\r\n" +
          ":alice!u@h PRIVMSG #room :two\r\n" +
          ":server BATCH -abc\r\n",
      );
      await expectEventually(() =>
        expect(lines.filter((line) => !line.startsWith(":server 001"))).toHaveLength(5),
      );
      expect(messages).toEqual(["one", "two"]);
      expect(errors).toHaveLength(0);
    });
  });
});
