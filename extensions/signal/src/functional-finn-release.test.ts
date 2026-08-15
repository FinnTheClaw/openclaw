import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
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
} from "./functional-finn-release.js";

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

function receipt(text: string, target: string): FunctionalFinnReleaseReceipt {
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
    evidenceDigest: "evidence",
    revision: 0,
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
        text: "answer",
        hasMedia: false,
      }),
    ).rejects.toThrow(/unverified/);
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        text: "answer",
        hasMedia: false,
        delivery: { kind: "host_control" },
      }),
    ).rejects.toThrow(/unverified/);
  });

  it("accepts exact receipts and returns the durable result on retry", async () => {
    const target = "+15551234567";
    const text = "verified answer";
    const signed = receipt(text, target);
    const delivery = { kind: "verified_candidate" as const, candidateText: text, receipt: signed };
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        text,
        hasMedia: false,
        delivery,
        now: 150,
      }),
    ).resolves.toMatchObject({ protected: true, receiptId: signed.receiptId });
    settleFunctionalFinnSignalRelease({ receiptId: signed.receiptId, messageId: "message-1" });
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        text,
        hasMedia: false,
        delivery,
        now: 150,
      }),
    ).resolves.toMatchObject({ replayed: { messageId: "message-1" } });
  });

  it("rejects payload, target, key, freshness, and media mismatches", async () => {
    const target = "+15551234567";
    const signed = receipt("answer", target);
    const base = {
      cfg: config(),
      accountId: "default",
      to: target,
      text: "answer",
      hasMedia: false,
      delivery: { kind: "verified_candidate" as const, candidateText: "answer", receipt: signed },
    };
    await expect(authorizeFunctionalFinnSignalSend({ ...base, text: "changed" })).rejects.toThrow();
    await expect(
      authorizeFunctionalFinnSignalSend({ ...base, to: "+15557654321" }),
    ).rejects.toThrow(/invalid/);
    await expect(authorizeFunctionalFinnSignalSend({ ...base, now: 201 })).rejects.toThrow(
      /invalid/,
    );
    await expect(authorizeFunctionalFinnSignalSend({ ...base, hasMedia: true })).rejects.toThrow(
      /unverified/,
    );
  });

  it("allows only branded host-control delivery and leaves OFF inert", async () => {
    const target = "+15551234567";
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: config(),
        accountId: "default",
        to: target,
        text: "pairing notice",
        hasMedia: false,
        delivery: createSignalHostControlDelivery(),
      }),
    ).resolves.toEqual({ protected: true });
    await expect(
      authorizeFunctionalFinnSignalSend({
        cfg: { channels: { signal: {} } } as never,
        accountId: "default",
        to: target,
        text: "ordinary send",
        hasMedia: false,
      }),
    ).resolves.toEqual({ protected: false });
  });
});
