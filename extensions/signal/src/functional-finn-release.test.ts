import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnTarget,
  serializeFunctionalFinnReceipt,
  type FunctionalFinnReleaseReceipt,
  type FunctionalFinnReleaseReceiptUnsigned,
} from "./functional-finn-release-receipt.js";
import {
  configureFunctionalFinnSignalReleaseStore,
  settleFunctionalFinnSignalRelease,
} from "./functional-finn-release-store.js";
import {
  authorizeFunctionalFinnSignalSend,
  createSignalHostControlDelivery,
  preflightFunctionalFinnSignalSend,
} from "./functional-finn-release.js";
import {
  buildFunctionalFinnSignalFrame,
  digestFunctionalFinnSignalFrame,
} from "./functional-finn-signal-frame.js";

const records = new Map<string, unknown>();
const runtime = {
  state: {
    openSyncKeyedStore: () => ({
      register: (key: string, value: unknown) => records.set(key, value),
      registerIfAbsent: (key: string, value: unknown) => {
        if (records.has(key)) {
          return false;
        }
        records.set(key, value);
        return true;
      },
      update: (key: string, mutate: (current: unknown) => unknown) => {
        records.set(key, mutate(records.get(key)));
        return true;
      },
      lookup: (key: string) => records.get(key),
      consume: () => undefined,
      delete: (key: string) => records.delete(key),
      entries: () => [],
      clear: () => records.clear(),
    }),
  },
} as never;

let directory = "";
let publicKeyFile = "";
let privateKey: KeyObject;

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
      },
    },
  } as never;
}

function frame(target: string, message = "verified answer") {
  return buildFunctionalFinnSignalFrame({
    accountId: "default",
    rpcParams: { message, account: "+15550001111", recipient: [target] },
  });
}

function receipt(
  text: string,
  target: string,
  releaseFrame = frame(target, text),
  revision: 0 | 1 = 0,
): FunctionalFinnReleaseReceipt {
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
    frameDigest: digestFunctionalFinnSignalFrame(releaseFrame),
    evidenceDigest: "evidence",
    revision,
    issuedAt: 100,
    expiresAt: 200,
  };
  return {
    ...unsigned,
    signature: sign(null, serializeFunctionalFinnReceipt(unsigned), privateKey).toString(
      "base64url",
    ),
  };
}

describe("Functional Finn Signal release gate", () => {
  beforeEach(async () => {
    records.clear();
    configureFunctionalFinnSignalReleaseStore(runtime);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-signal-"));
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    publicKeyFile = path.join(directory, "release.pub.pem");
    await fs.writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("blocks missing and forged release authority before delivery", async () => {
    const target = "+15551234567";
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: "answer",
        frame: frame(target, "answer"),
      }),
    ).rejects.toThrow(/unverified/);
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: "answer",
        frame: frame(target, "answer"),
        delivery: { kind: "host_control" },
      }),
    ).rejects.toThrow(/unverified/);
  });

  it("accepts exact receipts and returns the durable result on retry", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const releaseFrame = frame(target, text);
    const signed = receipt(text, target, releaseFrame);
    const delivery = { kind: "verified_candidate" as const, candidateText: text, receipt: signed };
    const first = await authorizeFunctionalFinnSignalSend({
      cfg: config(),
      accountId: "default",
      to: target,
      sourceText: text,
      frame: releaseFrame,
      delivery,
      now: 150,
    });
    expect(first).toMatchObject({ protected: true });
    if (!("logicalId" in first)) {
      throw new Error("expected logical release identity");
    }
    settleFunctionalFinnSignalRelease({
      logicalId: first.logicalId,
      messageId: "message-1",
      timestamp: 101,
    });
    configureFunctionalFinnSignalReleaseStore(runtime);
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: text,
        frame: releaseFrame,
        delivery,
        now: 150,
      }),
    ).resolves.toMatchObject({ replayed: { messageId: "message-1" } });
  });

  it("rejects payload, target, key, freshness, and media mismatches", async () => {
    const target = "+15551234567";
    const releaseFrame = frame(target, "answer");
    const signed = receipt("answer", target, releaseFrame);
    const base = {
      cfg: config(),
      accountId: "default",
      to: target,
      sourceText: "answer",
      frame: releaseFrame,
      delivery: { kind: "verified_candidate" as const, candidateText: "answer", receipt: signed },
    };
    await expect(
      authorizeFunctionalFinnSignalSend({ ...base, sourceText: "changed" }),
    ).rejects.toThrow();
    await expect(
      authorizeFunctionalFinnSignalSend({ ...base, to: "+15557654321" }),
    ).rejects.toThrow(/altered/);
    await expect(authorizeFunctionalFinnSignalSend({ ...base, now: 201 })).rejects.toThrow(
      /invalid/,
    );
    expect(() =>
      preflightFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        sourceText: "answer",
        hasMedia: true,
        delivery: base.delivery,
      }),
    ).toThrow(/unverified/);
  });

  it("allows only branded host-control delivery and leaves OFF inert", async () => {
    const target = "+15551234567";
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: "pairing notice",
        frame: frame(target, "pairing notice"),
        delivery: createSignalHostControlDelivery(),
      }),
    ).resolves.toEqual({ protected: true, hostControl: true });
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: { channels: { signal: {} } } as never,
        accountId: "default",
        to: target,
        sourceText: "ordinary send",
        frame: frame(target, "ordinary send"),
      }),
    ).resolves.toEqual({ protected: false });
  });

  it("does not authorize a second physical release when channel data is lost or rebuilt", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const releaseFrame = frame(target, text);
    const delivery = {
      kind: "verified_candidate" as const,
      candidateText: text,
      receipt: receipt(text, target, releaseFrame, 1),
    };
    const first = await authorizeFunctionalFinnSignalSend({
      cfg: config(),
      accountId: "default",
      to: target,
      sourceText: text,
      frame: releaseFrame,
      delivery,
      now: 150,
    });
    if (!("logicalId" in first)) {
      throw new Error("expected logical release identity");
    }
    settleFunctionalFinnSignalRelease({
      logicalId: first.logicalId,
      messageId: "sent-once",
      timestamp: 102,
    });
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: text,
        frame: releaseFrame,
        now: 150,
      }),
    ).rejects.toThrow(/unverified/);
    configureFunctionalFinnSignalReleaseStore(runtime);
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: text,
        frame: releaseFrame,
        delivery,
        now: 150,
      }),
    ).resolves.toMatchObject({ replayed: { messageId: "sent-once" } });
  });

  it("binds a host frame once and reuses its durable signed issuance after reconstruction", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const releaseFrame = frame(target, text);
    const socketPath = path.join(directory, "verifier.sock");
    let issuanceCount = 0;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.on("end", () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(request.frame).toEqual(releaseFrame);
        issuanceCount += 1;
        socket.end(JSON.stringify({ ok: true, receipt: receipt(text, target, releaseFrame) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const delivery = {
      kind: "verified_candidate" as const,
      candidateText: text,
      authorization: {
        schemaVersion: 1 as const,
        authorizationId: "authorization-1",
        keyId: "key-1",
        nonce: "nonce",
        agentId: "finn",
        sessionKeyDigest: "session",
        runId: "run",
        channel: "signal" as const,
        accountId: "default",
        targetDigest: digestFunctionalFinnTarget(target),
        payloadDigest: digestFunctionalFinnPayload(text),
        evidenceDigest: "evidence",
        revision: 0 as const,
        issuedAt: 100,
        expiresAt: 200,
        signature: "authorization-signature",
      },
      verifier: { socketPath, timeoutMs: 1_000 },
    };
    try {
      const first = await authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        sourceText: text,
        frame: releaseFrame,
        delivery,
        now: 150,
      });
      if (!("logicalId" in first)) {
        throw new Error("expected logical release identity");
      }
      settleFunctionalFinnSignalRelease({
        logicalId: first.logicalId,
        messageId: "sent",
        timestamp: 103,
      });
      configureFunctionalFinnSignalReleaseStore(runtime);
      await expect(
        authorizeFunctionalFinnSignalSend({
          cfg: config(),
          accountId: "default",
          to: target,
          sourceText: text,
          frame: releaseFrame,
          delivery,
          now: 150,
        }),
      ).resolves.toMatchObject({ replayed: { messageId: "sent" } });
      expect(issuanceCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
