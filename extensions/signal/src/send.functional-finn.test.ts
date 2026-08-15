import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnTarget,
  serializeFunctionalFinnReceipt,
  type FunctionalFinnReleaseReceiptUnsigned,
} from "./functional-finn-release-receipt.js";
import { configureFunctionalFinnSignalReleaseStore } from "./functional-finn-release-store.js";
import {
  buildFunctionalFinnSignalFrame,
  digestFunctionalFinnSignalFrame,
  type FunctionalFinnSignalFrame,
} from "./functional-finn-signal-frame.js";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

const { sendMessageSignal } = await import("./send.js");
const records = new Map<string, unknown>();
let releaseStoreCapacity = Number.POSITIVE_INFINITY;
let releaseStoreOptions: Record<string, unknown> | undefined;
configureFunctionalFinnSignalReleaseStore({
  state: {
    openSyncKeyedStore: (options: Record<string, unknown>) => {
      releaseStoreOptions = options;
      return {
        register: (key: string, value: unknown) => records.set(key, value),
        registerIfAbsent: (key: string, value: unknown) => {
          if (records.has(key) || records.size >= releaseStoreCapacity) {
            return false;
          }
          records.set(key, value);
          return true;
        },
        update: (key: string, mutate: (value: unknown) => unknown) => {
          records.set(key, mutate(records.get(key)));
          return true;
        },
        lookup: (key: string) => records.get(key),
        consume: () => undefined,
        delete: (key: string) => records.delete(key),
        entries: () => [],
        clear: () => records.clear(),
      };
    },
  },
} as never);

let directory = "";
let publicKeyFile = "";
let privateKey: KeyObject;
let servers: net.Server[] = [];

function config() {
  return {
    channels: {
      signal: {
        functionalFinnRelease: {
          enabled: true,
          publicKeyFile,
          keyId: "key-1",
          maxLifetimeMs: 1_000,
        },
        accounts: {
          default: { httpUrl: "http://signal.test", account: "+15550001111" },
        },
      },
    },
  } as never;
}

function signed(
  text: string,
  target: string,
  rpcParams: Record<string, unknown> = {
    message: text,
    account: "+15550001111",
    recipient: [target],
  },
) {
  return signedFrame(
    text,
    target,
    buildFunctionalFinnSignalFrame({
      accountId: "default",
      rpcParams,
    }),
  );
}

function signedFrame(text: string, target: string, frame: FunctionalFinnSignalFrame) {
  const unsigned: FunctionalFinnReleaseReceiptUnsigned = {
    schemaVersion: 1,
    receiptId: randomUUID(),
    keyId: "key-1",
    nonce: randomUUID(),
    agentId: "finn",
    sessionKeyDigest: "session",
    runId: "run",
    channel: "signal",
    accountId: "default",
    targetDigest: digestFunctionalFinnTarget(target),
    payloadDigest: digestFunctionalFinnPayload(text),
    frameDigest: digestFunctionalFinnSignalFrame(frame),
    evidenceDigest: "evidence",
    revision: 0,
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + 900,
  };
  return {
    ...unsigned,
    signature: sign(null, serializeFunctionalFinnReceipt(unsigned), privateKey).toString(
      "base64url",
    ),
  };
}

function authorization(text: string, target: string) {
  return {
    schemaVersion: 1 as const,
    authorizationId: randomUUID(),
    keyId: "key-1",
    nonce: randomUUID(),
    agentId: "finn",
    sessionKeyDigest: "session",
    runId: "run",
    channel: "signal" as const,
    accountId: "default",
    targetDigest: digestFunctionalFinnTarget(target),
    payloadDigest: digestFunctionalFinnPayload(text),
    evidenceDigest: "evidence",
    revision: 0 as const,
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + 900,
    signature: "verifier-owned",
  };
}

async function startFrameVerifier(text: string, target: string) {
  const socketPath = path.join(directory, `verifier-${randomUUID()}.sock`);
  const frames: FunctionalFinnSignalFrame[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        frame: FunctionalFinnSignalFrame;
      };
      frames.push(request.frame);
      socket.end(JSON.stringify({ ok: true, receipt: signedFrame(text, target, request.frame) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  return { socketPath, frames };
}

describe("sendMessageSignal Functional Finn enforcement", () => {
  beforeEach(async () => {
    records.clear();
    releaseStoreCapacity = Number.POSITIVE_INFINITY;
    servers = [];
    signalRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 123 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-send-"));
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    publicKeyFile = path.join(directory, "release.pub.pem");
    await fs.writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses reject-new delivery authority with no expiry", () => {
    expect(releaseStoreOptions).toEqual({
      namespace: "functional-finn-release-delivery-v2",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
  });

  it("rejects before the physical RPC when release authority is absent", async () => {
    await expect(
      sendMessageSignal("+15551234567", "unverified", { cfg: config() }),
    ).rejects.toThrow(/blocked unverified/);
    expect(signalRpcRequestMock).not.toHaveBeenCalled();
  });

  it("sends one exact verified payload and replays its durable result without a second RPC", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const receipt = signed(text, target);
    const options = {
      cfg: config(),
      functionalFinnDelivery: { kind: "verified_candidate" as const, candidateText: text, receipt },
    };
    await expect(sendMessageSignal(target, text, options)).resolves.toMatchObject({
      messageId: "123",
    });
    await expect(sendMessageSignal(target, text, options)).resolves.toMatchObject({
      messageId: "123",
    });
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an identity-less RPC result pending and retries with zero new RPCs", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const options = {
      cfg: config(),
      functionalFinnDelivery: {
        kind: "verified_candidate" as const,
        candidateText: text,
        receipt: signed(text, target),
      },
    };
    signalRpcRequestMock.mockResolvedValue(undefined);
    await expect(sendMessageSignal(target, text, options)).rejects.toThrow(
      /no durable message identity/,
    );
    await expect(sendMessageSignal(target, text, options)).rejects.toThrow(/outcome is unknown/);
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });

  it("rejects overflow before RPC while retaining replay for the oldest release", async () => {
    releaseStoreCapacity = 1;
    const firstTarget = "+15551234567";
    const secondTarget = "+15551234568";
    const text = "verified answer";
    const first = {
      cfg: config(),
      functionalFinnDelivery: {
        kind: "verified_candidate" as const,
        candidateText: text,
        receipt: signed(text, firstTarget),
      },
    };
    await expect(sendMessageSignal(firstTarget, text, first)).resolves.toMatchObject({
      messageId: "123",
    });
    await expect(
      sendMessageSignal(secondTarget, text, {
        cfg: config(),
        functionalFinnDelivery: {
          kind: "verified_candidate",
          candidateText: text,
          receipt: signed(text, secondTarget),
        },
      }),
    ).rejects.toThrow(/capacity exhausted/);
    await expect(sendMessageSignal(firstTarget, text, first)).resolves.toMatchObject({
      messageId: "123",
    });
    expect(records.size).toBe(1);
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });

  it("settles quoted rejection and its separately bound fallback exactly once", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const verifier = await startFrameVerifier(text, target);
    signalRpcRequestMock
      .mockRejectedValueOnce(new Error("quote metadata invalid"))
      .mockResolvedValueOnce({ timestamp: 456 });
    const options = {
      cfg: config(),
      replyToId: "123",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
      functionalFinnDelivery: {
        kind: "verified_candidate" as const,
        candidateText: text,
        authorization: authorization(text, target),
        verifier: { socketPath: verifier.socketPath, timeoutMs: 1_000 },
      },
    };
    await expect(sendMessageSignal(target, text, options)).resolves.toMatchObject({
      messageId: "456",
    });
    await expect(sendMessageSignal(target, text, options)).resolves.toMatchObject({
      messageId: "456",
    });
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
    expect(verifier.frames).toHaveLength(2);
    expect(verifier.frames[0]?.quoteTimestamp).toBe(123);
    expect(verifier.frames[1]?.quoteTimestamp).toBeNull();
    expect(digestFunctionalFinnSignalFrame(verifier.frames[0])).not.toBe(
      digestFunctionalFinnSignalFrame(verifier.frames[1]),
    );
  });

  it("binds receipts to the exact markdown, table, and explicit-style RPC frames", async () => {
    const target = "+15551234567";
    const cases: Array<{
      text: string;
      expectedMessage: string;
      styles: SignalTextStyleRange[];
      opts?: { textMode: "plain"; textStyles: SignalTextStyleRange[] };
      tableMode?: "code";
    }> = [];
    const markdown = markdownToSignalText("**bold**");
    cases.push({ text: "**bold**", expectedMessage: markdown.text, styles: markdown.styles });
    const tableText = "| A | B |\n|---|---|\n| 1 | 2 |";
    const table = markdownToSignalText(tableText, { tableMode: "code" });
    cases.push({
      text: tableText,
      expectedMessage: table.text,
      styles: table.styles,
      tableMode: "code",
    });
    const explicitStyles: SignalTextStyleRange[] = [
      { start: 0, length: 6, style: "ITALIC" },
      { start: 0, length: 6, style: "SPOILER" },
    ];
    cases.push({
      text: "styled",
      expectedMessage: "styled",
      styles: explicitStyles,
      opts: { textMode: "plain", textStyles: explicitStyles },
    });

    for (const [index, candidate] of cases.entries()) {
      const cfg = config();
      const mutableConfig = cfg as unknown as {
        channels: { signal: { markdown?: { tables?: "code" } } };
      };
      if (candidate.tableMode) {
        mutableConfig.channels.signal.markdown = { tables: candidate.tableMode };
      }
      const rpcParams: Record<string, unknown> = {
        message: candidate.expectedMessage,
        account: "+15550001111",
        recipient: [target],
      };
      if (candidate.styles.length > 0) {
        rpcParams["text-style"] = candidate.styles.map(
          (style) => `${style.start}:${style.length}:${style.style}`,
        );
      }
      const receipt = signed(candidate.text, target, rpcParams);
      await sendMessageSignal(target, candidate.text, {
        cfg,
        ...candidate.opts,
        functionalFinnDelivery: {
          kind: "verified_candidate",
          candidateText: candidate.text,
          receipt,
        },
      });
      expect(signalRpcRequestMock).toHaveBeenNthCalledWith(
        index + 1,
        "send",
        rpcParams,
        expect.any(Object),
      );
    }
  });
});
