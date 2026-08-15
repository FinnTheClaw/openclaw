import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const FRAME_SCHEMA = "functional-finn.signal.send.v1" as const;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const FRAME_KEYS = [
  "schema",
  "method",
  "accountId",
  "account",
  "targetKind",
  "targetValue",
  "message",
  "textStyle",
  "quoteTimestamp",
  "quoteAuthor",
  "quoteMessage",
] as const;
const RPC_KEYS = new Set([
  "message",
  "text-style",
  "account",
  "recipient",
  "groupId",
  "username",
  "quoteTimestamp",
  "quoteAuthor",
  "quoteMessage",
]);

type TargetKind = "recipient" | "group" | "username";

export type FunctionalFinnSignalFrame = Readonly<{
  schema: typeof FRAME_SCHEMA;
  method: "send";
  accountId: string;
  account: string | null;
  targetKind: TargetKind;
  targetValue: string;
  message: string;
  textStyle: readonly string[];
  quoteTimestamp: number | null;
  quoteAuthor: string | null;
  quoteMessage: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalString(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.normalize("NFC") !== value ||
    hasUnpairedSurrogate(value)
  ) {
    throw new Error("Functional Finn Signal frame contains a noncanonical string");
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Functional Finn Signal frame contains unknown or missing fields");
  }
}

function canonicalStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new Error("Functional Finn Signal frame contains a noncanonical array");
  }
  return value.map((item) => canonicalString(item));
}

function singleDestination(params: Record<string, unknown>): {
  kind: TargetKind;
  value: string;
} {
  const destinations = ["recipient", "groupId", "username"].filter((key) =>
    Object.hasOwn(params, key),
  );
  if (destinations.length !== 1) {
    throw new Error("Functional Finn Signal frame requires exactly one destination");
  }
  const key = destinations[0];
  if (key === "groupId") {
    return { kind: "group", value: canonicalString(params.groupId) };
  }
  const values = params[key];
  if (!Array.isArray(values) || values.length !== 1 || Object.keys(values).length !== 1) {
    throw new Error("Functional Finn Signal frame destination must contain one value");
  }
  return {
    kind: key === "recipient" ? "recipient" : "username",
    value: canonicalString(values[0]),
  };
}

function quoteFields(params: Record<string, unknown>): {
  quoteTimestamp: number | null;
  quoteAuthor: string | null;
  quoteMessage: string | null;
} {
  const keys = ["quoteTimestamp", "quoteAuthor", "quoteMessage"] as const;
  if (!keys.some((key) => Object.hasOwn(params, key))) {
    return { quoteTimestamp: null, quoteAuthor: null, quoteMessage: null };
  }
  const timestamp = params.quoteTimestamp;
  if (
    !keys.every((key) => Object.hasOwn(params, key)) ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > MAX_SAFE_INTEGER
  ) {
    throw new Error("Functional Finn Signal frame quote is incomplete or noncanonical");
  }
  return {
    quoteTimestamp: timestamp,
    quoteAuthor: canonicalString(params.quoteAuthor),
    quoteMessage: canonicalString(params.quoteMessage, true),
  };
}

export function buildFunctionalFinnSignalFrame(params: {
  accountId: string;
  rpcParams: Record<string, unknown>;
}): FunctionalFinnSignalFrame {
  const unknown = Object.keys(params.rpcParams).filter((key) => !RPC_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error("Functional Finn Signal frame contains unsupported RPC fields");
  }
  const target = singleDestination(params.rpcParams);
  const rawStyles = params.rpcParams["text-style"] ?? [];
  const textStyle = Object.freeze(canonicalStringArray(rawStyles));
  const account =
    params.rpcParams.account === undefined ? null : canonicalString(params.rpcParams.account);
  return Object.freeze({
    schema: FRAME_SCHEMA,
    method: "send",
    accountId: canonicalString(params.accountId),
    account,
    targetKind: target.kind,
    targetValue: target.value,
    message: canonicalString(params.rpcParams.message),
    textStyle,
    ...quoteFields(params.rpcParams),
  });
}

export function encodeFunctionalFinnSignalFrame(value: unknown): Buffer {
  if (!isRecord(value)) {
    throw new Error("Functional Finn Signal frame must be an object");
  }
  assertExactKeys(value, FRAME_KEYS);
  if (value.schema !== FRAME_SCHEMA || value.method !== "send") {
    throw new Error("Functional Finn Signal frame schema or method is invalid");
  }
  const targetKind = value.targetKind;
  if (targetKind !== "recipient" && targetKind !== "group" && targetKind !== "username") {
    throw new Error("Functional Finn Signal frame target kind is invalid");
  }
  const textStyle = value.textStyle;
  const canonicalTextStyle = canonicalStringArray(textStyle);
  const timestamp = value.quoteTimestamp;
  const quoteAbsent =
    timestamp === null && value.quoteAuthor === null && value.quoteMessage === null;
  const quotePresent =
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= MAX_SAFE_INTEGER &&
    typeof value.quoteAuthor === "string" &&
    typeof value.quoteMessage === "string";
  if (!quoteAbsent && !quotePresent) {
    throw new Error("Functional Finn Signal frame quote is incomplete or noncanonical");
  }
  const ordered = [
    FRAME_SCHEMA,
    "send",
    canonicalString(value.accountId),
    value.account === null ? null : canonicalString(value.account),
    targetKind,
    canonicalString(value.targetValue),
    canonicalString(value.message),
    canonicalTextStyle,
    timestamp,
    value.quoteAuthor === null ? null : canonicalString(value.quoteAuthor),
    value.quoteMessage === null ? null : canonicalString(value.quoteMessage, true),
  ];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function digestFunctionalFinnSignalFrame(frame: unknown): string {
  return createHash("sha256").update(encodeFunctionalFinnSignalFrame(frame)).digest("hex");
}
