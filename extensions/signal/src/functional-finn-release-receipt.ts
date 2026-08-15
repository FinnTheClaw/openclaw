import { createHash, verify } from "node:crypto";

export type FunctionalFinnReleaseReceiptUnsigned = {
  schemaVersion: 1;
  receiptId: string;
  keyId: string;
  nonce: string;
  agentId: string;
  sessionKeyDigest: string;
  runId: string;
  channel: "signal";
  accountId: string;
  targetDigest: string;
  payloadDigest: string;
  evidenceDigest: string;
  revision: 0 | 1;
  issuedAt: number;
  expiresAt: number;
};

export type FunctionalFinnReleaseReceipt = FunctionalFinnReleaseReceiptUnsigned & {
  signature: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const digestFunctionalFinnPayload = digest;
export const digestFunctionalFinnSessionKey = digest;
export const digestFunctionalFinnTarget = (target: string): string =>
  digest(target.trim().toLowerCase());

export function serializeFunctionalFinnReceipt(
  receipt: FunctionalFinnReleaseReceiptUnsigned,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      receipt.schemaVersion,
      receipt.receiptId,
      receipt.keyId,
      receipt.nonce,
      receipt.agentId,
      receipt.sessionKeyDigest,
      receipt.runId,
      receipt.channel,
      receipt.accountId,
      receipt.targetDigest,
      receipt.payloadDigest,
      receipt.evidenceDigest,
      receipt.revision,
      receipt.issuedAt,
      receipt.expiresAt,
    ]),
    "utf8",
  );
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseFunctionalFinnReleaseReceipt(
  value: unknown,
): FunctionalFinnReleaseReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receiptId = stringField(record, "receiptId");
  const keyId = stringField(record, "keyId");
  const nonce = stringField(record, "nonce");
  const agentId = stringField(record, "agentId");
  const sessionKeyDigest = stringField(record, "sessionKeyDigest");
  const runId = stringField(record, "runId");
  const accountId = stringField(record, "accountId");
  const targetDigest = stringField(record, "targetDigest");
  const payloadDigest = stringField(record, "payloadDigest");
  const evidenceDigest = stringField(record, "evidenceDigest");
  const signature = stringField(record, "signature");
  if (
    record.schemaVersion !== 1 ||
    record.channel !== "signal" ||
    (record.revision !== 0 && record.revision !== 1) ||
    typeof record.issuedAt !== "number" ||
    !Number.isSafeInteger(record.issuedAt) ||
    typeof record.expiresAt !== "number" ||
    !Number.isSafeInteger(record.expiresAt) ||
    !receiptId ||
    !keyId ||
    !nonce ||
    !agentId ||
    !sessionKeyDigest ||
    !runId ||
    !accountId ||
    !targetDigest ||
    !payloadDigest ||
    !evidenceDigest ||
    !signature
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    receiptId,
    keyId,
    nonce,
    agentId,
    sessionKeyDigest,
    runId,
    channel: "signal",
    accountId,
    targetDigest,
    payloadDigest,
    evidenceDigest,
    revision: record.revision,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    signature,
  };
}

export function verifyFunctionalFinnReleaseReceipt(params: {
  receipt: FunctionalFinnReleaseReceipt;
  publicKeyPem: string;
  expectedKeyId: string;
  expected: Pick<
    FunctionalFinnReleaseReceiptUnsigned,
    "accountId" | "targetDigest" | "payloadDigest"
  >;
  now: number;
  maxLifetimeMs: number;
}): boolean {
  const { receipt } = params;
  if (
    receipt.keyId !== params.expectedKeyId ||
    receipt.accountId !== params.expected.accountId ||
    receipt.targetDigest !== params.expected.targetDigest ||
    receipt.payloadDigest !== params.expected.payloadDigest ||
    receipt.issuedAt > params.now ||
    receipt.expiresAt < params.now ||
    receipt.expiresAt - receipt.issuedAt > params.maxLifetimeMs
  ) {
    return false;
  }
  const { signature, ...unsigned } = receipt;
  try {
    return verify(
      null,
      serializeFunctionalFinnReceipt(unsigned),
      params.publicKeyPem,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
