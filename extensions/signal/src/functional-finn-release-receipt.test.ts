import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnFrame,
  digestFunctionalFinnTarget,
  parseFunctionalFinnReleaseReceipt,
  serializeFunctionalFinnReceipt,
  verifyFunctionalFinnReleaseReceipt,
  type FunctionalFinnReleaseReceipt,
  type FunctionalFinnReleaseReceiptUnsigned,
} from "./functional-finn-release-receipt.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

function receipt(): FunctionalFinnReleaseReceipt {
  const unsigned: FunctionalFinnReleaseReceiptUnsigned = {
    schemaVersion: 1,
    receiptId: randomUUID(),
    keyId: "functional-finn-test-1",
    nonce: "nonce-1",
    agentId: "finn",
    sessionKeyDigest: "session-digest",
    runId: "run-1",
    channel: "signal",
    accountId: "default",
    targetDigest: digestFunctionalFinnTarget("+15551234567"),
    payloadDigest: digestFunctionalFinnPayload("verified answer"),
    frameDigest: digestFunctionalFinnFrame({
      method: "send",
      params: { message: "verified answer" },
    }),
    evidenceDigest: "evidence-digest",
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

describe("Functional Finn release receipts", () => {
  it("verifies exact signed payload and routing bindings", () => {
    const value = receipt();
    expect(
      verifyFunctionalFinnReleaseReceipt({
        receipt: value,
        publicKeyPem,
        expectedKeyId: value.keyId,
        expected: {
          accountId: value.accountId,
          targetDigest: value.targetDigest,
          payloadDigest: value.payloadDigest,
          frameDigest: value.frameDigest,
        },
        now: 150,
        maxLifetimeMs: 1_000,
      }),
    ).toBe(true);
  });

  it.each(["accountId", "targetDigest", "payloadDigest", "frameDigest"] as const)(
    "rejects an altered %s binding",
    (field) => {
      const value = receipt();
      expect(
        verifyFunctionalFinnReleaseReceipt({
          receipt: { ...value, [field]: `${value[field]}-altered` },
          publicKeyPem,
          expectedKeyId: value.keyId,
          expected: {
            accountId: value.accountId,
            targetDigest: value.targetDigest,
            payloadDigest: value.payloadDigest,
            frameDigest: value.frameDigest,
          },
          now: 150,
          maxLifetimeMs: 1_000,
        }),
      ).toBe(false);
    },
  );

  it("rejects stale, oversized-lifetime, malformed, and wrong-key receipts", () => {
    const value = receipt();
    const expected = {
      accountId: value.accountId,
      targetDigest: value.targetDigest,
      payloadDigest: value.payloadDigest,
      frameDigest: value.frameDigest,
    };
    expect(
      verifyFunctionalFinnReleaseReceipt({
        receipt: value,
        publicKeyPem,
        expectedKeyId: value.keyId,
        expected,
        now: 201,
        maxLifetimeMs: 1_000,
      }),
    ).toBe(false);
    expect(
      verifyFunctionalFinnReleaseReceipt({
        receipt: value,
        publicKeyPem,
        expectedKeyId: value.keyId,
        expected,
        now: 150,
        maxLifetimeMs: 50,
      }),
    ).toBe(false);
    expect(parseFunctionalFinnReleaseReceipt({ ...value, signature: "" })).toBeUndefined();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    expect(
      verifyFunctionalFinnReleaseReceipt({
        receipt: value,
        publicKeyPem: other,
        expectedKeyId: value.keyId,
        expected,
        now: 150,
        maxLifetimeMs: 1_000,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "markdown",
      {
        schemaVersion: 1,
        method: "send",
        accountId: "default",
        targetDigest: "target",
        params: {
          message: "bold",
          "text-style": ["0:4:BOLD"],
          account: "+15550001111",
          recipient: ["+15551234567"],
        },
      },
      "4937ca36357678e942226d5b50492dfc430bc36d659b32e150e588fb8ae8caa0",
    ],
    [
      "table",
      {
        schemaVersion: 1,
        method: "send",
        accountId: "default",
        targetDigest: "target",
        params: {
          message: "A | B\n-- | --\n1 | 2",
          account: "+15550001111",
          groupId: "group-1",
        },
      },
      "7cec3be01710f7f481ca1694b742dd748c51079bce595bde22ed37c081f7d39f",
    ],
    [
      "plain styles",
      {
        schemaVersion: 1,
        method: "send",
        accountId: "work",
        targetDigest: "target",
        params: {
          message: "styled",
          "text-style": ["0:6:ITALIC", "0:6:SPOILER"],
          username: ["u:alice"],
        },
      },
      "aa2f48aa61950ed1daf789a901372f374bedf6272fdc62ad9ae6273c2ef1665f",
    ],
  ])("has an exact canonical %s RPC frame digest", (_name, frame, expected) => {
    expect(digestFunctionalFinnFrame(frame)).toBe(expected);
  });

  it("distinguishes the exact quoted RPC frame from its fallback frame", () => {
    const fallback = {
      schemaVersion: 1,
      method: "send",
      accountId: "default",
      targetDigest: "target",
      params: {
        message: "reply",
        account: "+15550001111",
        recipient: ["+15551234567"],
      },
    };
    const quoted = {
      ...fallback,
      params: {
        ...fallback.params,
        quoteTimestamp: 123,
        quoteAuthor: "+15550002222",
        quoteMessage: "original",
      },
    };
    expect(digestFunctionalFinnFrame(quoted)).toBe(
      "a531df361509b73cb0118b22a95fbafcf052804caafcdcae5160df0d3dbf9bcd",
    );
    expect(digestFunctionalFinnFrame(fallback)).toBe(
      "60a73a866bfd193a95032865e88d4b038869122c265f9e16e647cb42e8617930",
    );
  });
});
