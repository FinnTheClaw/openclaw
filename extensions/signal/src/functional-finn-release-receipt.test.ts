import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestFunctionalFinnPayload,
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
    frameDigest: "frame-digest",
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
});
