import { Buffer } from "node:buffer";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_DEPTH = 8;
const TRUNCATED = "[Truncated]";

type Budget = {
  remainingItems: number;
  maxDepth: number;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function clipBoundedFunctionalFinnEvidenceText(
  value: string,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) {
    throw new Error("Functional Finn evidence maxBytes must be at least 32");
  }
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  let best = TRUNCATED;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${TRUNCATED}`;
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function encodeStringWithin(value: string, maxBytes: number): string | undefined {
  if (maxBytes < 2) {
    return undefined;
  }
  const boundedInput = value.slice(0, Math.min(value.length, maxBytes));
  let low = 0;
  let high = boundedInput.length;
  let best = '""';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const suffix = middle < value.length ? TRUNCATED : "";
    const candidate = JSON.stringify(`${boundedInput.slice(0, middle)}${suffix}`);
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function primitive(value: unknown, maxBytes: number): string | undefined {
  if (typeof value === "string") {
    return encodeStringWithin(value, maxBytes);
  }
  if (value === null || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    return byteLength(encoded) <= maxBytes ? encoded : undefined;
  }
  if (typeof value === "number") {
    const encoded = Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    return byteLength(encoded) <= maxBytes ? encoded : undefined;
  }
  if (typeof value === "bigint") {
    return encodeStringWithin(value.toString(), maxBytes);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return encodeStringWithin(`[${typeof value}]`, maxBytes);
  }
  return undefined;
}

function encodeValue(
  value: unknown,
  maxBytes: number,
  depth: number,
  budget: Budget,
  ancestors: Set<object>,
): string | undefined {
  if (budget.remainingItems <= 0) {
    return encodeStringWithin(TRUNCATED, maxBytes);
  }
  budget.remainingItems -= 1;
  const encodedPrimitive = primitive(value, maxBytes);
  if (encodedPrimitive !== undefined) {
    return encodedPrimitive;
  }
  if (typeof value !== "object" || value === null) {
    return encodeStringWithin("[Unsupported]", maxBytes);
  }
  if (depth >= budget.maxDepth) {
    return encodeStringWithin("[Max depth]", maxBytes);
  }
  if (ancestors.has(value)) {
    return encodeStringWithin("[Circular]", maxBytes);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let output = "[";
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const actualLength =
        typeof lengthDescriptor?.value === "number" && Number.isSafeInteger(lengthDescriptor.value)
          ? lengthDescriptor.value
          : 0;
      const length = Math.min(actualLength, budget.remainingItems);
      for (let index = 0; index < length; index += 1) {
        const prefix = index === 0 ? "" : ",";
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const child = encodeValue(
          descriptor && "value" in descriptor ? descriptor.value : "[Accessor omitted]",
          maxBytes - byteLength(output) - byteLength(prefix) - 1,
          depth + 1,
          budget,
          ancestors,
        );
        if (child === undefined) {
          break;
        }
        output += `${prefix}${child}`;
      }
      if (actualLength > length && budget.remainingItems > 0) {
        const marker = `${output.length > 1 ? "," : ""}${JSON.stringify(TRUNCATED)}`;
        if (byteLength(output) + byteLength(marker) + 1 <= maxBytes) {
          output += marker;
        }
      }
      return `${output}]`;
    }

    let output = "{";
    let emitted = 0;
    try {
      for (const key in value as Record<string, unknown>) {
        if (budget.remainingItems <= 0) {
          break;
        }
        if (!Object.hasOwn(value, key)) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const keyEncoded = encodeStringWithin(key, Math.min(maxBytes, 1024));
        if (!descriptor || !keyEncoded) {
          continue;
        }
        const prefix = emitted === 0 ? "" : ",";
        const separatorBytes = byteLength(prefix) + byteLength(keyEncoded) + 2;
        const child = encodeValue(
          "value" in descriptor ? descriptor.value : "[Accessor omitted]",
          maxBytes - byteLength(output) - separatorBytes - 1,
          depth + 1,
          budget,
          ancestors,
        );
        if (child === undefined) {
          break;
        }
        output += `${prefix}${keyEncoded}:${child}`;
        emitted += 1;
      }
    } catch {
      const markerKey = encodeStringWithin("$error", 32);
      const markerValue = encodeStringWithin("[Enumeration failed]", 64);
      if (
        markerKey &&
        markerValue &&
        byteLength(output) + byteLength(markerKey) + byteLength(markerValue) + 3 <= maxBytes
      ) {
        output += `${emitted > 0 ? "," : ""}${markerKey}:${markerValue}`;
      }
    }
    return `${output}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function serializeBoundedFunctionalFinnEvidence(
  value: unknown,
  options?: { maxBytes?: number; maxItems?: number; maxDepth?: number },
): string {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const budget: Budget = {
    remainingItems: options?.maxItems ?? DEFAULT_MAX_ITEMS,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) {
    throw new Error("Functional Finn evidence maxBytes must be at least 32");
  }
  if (typeof value === "string") {
    return clipBoundedFunctionalFinnEvidenceText(value, maxBytes);
  }
  const encoded = encodeValue(value, maxBytes, 0, budget, new Set()) ?? JSON.stringify(TRUNCATED);
  if (byteLength(encoded) > maxBytes) {
    throw new Error("Functional Finn bounded evidence encoder exceeded its byte budget");
  }
  return encoded;
}
