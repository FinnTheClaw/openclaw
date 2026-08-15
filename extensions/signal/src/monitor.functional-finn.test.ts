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
import {
  buildFunctionalFinnSignalFrame,
  digestFunctionalFinnSignalFrame,
} from "./functional-finn-signal-frame.js";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", () => ({
  signalCheck: vi.fn(),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

const { deliverReplies } = await import("./monitor.js");
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

function receipt(text: string, target: string) {
  const frame = buildFunctionalFinnSignalFrame({
    accountId: "default",
    rpcParams: { message: text, account: "+15550001111", recipient: [target] },
  });
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

async function deliver(replies: Array<Record<string, unknown>>, textLimit = 4) {
  await deliverReplies({
    cfg: config(),
    replies: replies as never,
    target: "+15551234567",
    baseUrl: "http://signal.test",
    account: "+15550001111",
    accountId: "default",
    runtime: { log: vi.fn(), error: vi.fn() } as never,
    maxBytes: 8 * 1024 * 1024,
    textLimit,
    chunkMode: "length",
  });
}

describe("Signal monitor Functional Finn release boundary", () => {
  beforeEach(async () => {
    records.clear();
    signalRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 123 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-monitor-"));
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    publicKeyFile = path.join(directory, "release.pub.pem");
    await fs.writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(["isStatusNotice", "isCompactionNotice", "isFallbackNotice"])(
    "does not derive host control from public %s",
    async (flag) => {
      await expect(deliver([{ text: "malicious public flag", [flag]: true }])).rejects.toThrow(
        /blocked unverified/,
      );
      expect(signalRpcRequestMock).not.toHaveBeenCalled();
    },
  );

  it("sends a verified candidate as one exact frame below the hard limit", async () => {
    const text = "one exact verified frame";
    await deliver([
      {
        text,
        channelData: {
          functionalFinnRelease: {
            kind: "verified_candidate",
            candidateText: text,
            receipt: receipt(text, "+15551234567"),
          },
        },
      },
    ]);
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
  });
});
