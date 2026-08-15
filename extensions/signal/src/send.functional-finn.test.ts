import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnTarget,
  serializeFunctionalFinnReceipt,
  type FunctionalFinnReleaseReceiptUnsigned,
} from "./functional-finn-release-receipt.js";
import { configureFunctionalFinnSignalReleaseStore } from "./functional-finn-release-store.js";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

const { sendMessageSignal } = await import("./send.js");
const records = new Map<string, unknown>();
configureFunctionalFinnSignalReleaseStore({
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
      update: (key: string, mutate: (value: unknown) => unknown) => {
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
} as never);

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
        accounts: {
          default: { httpUrl: "http://signal.test", account: "+15550001111" },
        },
      },
    },
  } as never;
}

function signed(text: string, target: string) {
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

describe("sendMessageSignal Functional Finn enforcement", () => {
  beforeEach(async () => {
    records.clear();
    signalRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 123 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-send-"));
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    publicKeyFile = path.join(directory, "release.pub.pem");
    await fs.writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
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
});
