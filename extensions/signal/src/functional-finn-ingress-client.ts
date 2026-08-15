import net from "node:net";

const SCHEMA = "functional-finn.release-ipc.v1" as const;
const MAX_PACKET_BYTES = 256 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FunctionalFinnIngressRecord = {
  ingressId: string;
  bindingId: string;
  accountId: string;
  sourceId: string;
  sourceKind: "phone" | "uuid";
  conversationId: string;
  conversationKind: "direct" | "group";
  ordinal: number;
  sequence: number;
  receivedAt: number;
  contentDigest: string;
  content: string;
};

function canonicalize(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Functional Finn IPC forbids non-integer numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Functional Finn IPC value is not canonical JSON");
  }
  const result: Record<string, Json> = {};
  for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
}

export function encodeFunctionalFinnIngressPull(params: {
  requestId: string;
  afterOrdinal: number;
  limit: number;
}): Buffer {
  const body = Buffer.from(
    JSON.stringify(
      canonicalize({
        afterOrdinal: params.afterOrdinal,
        limit: params.limit,
        op: "ingress.pull",
        requestId: params.requestId,
        schema: SCHEMA,
      }),
    ),
    "utf8",
  );
  if (body.length > MAX_PACKET_BYTES) {
    throw new Error("Functional Finn ingress request is oversized");
  }
  const packet = Buffer.allocUnsafe(body.length + 4);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value || value.length > 65_536) {
    throw new Error(`Functional Finn ingress ${key} is invalid`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Functional Finn ingress ${key} is invalid`);
  }
  return value as number;
}

function parseIngress(value: unknown): FunctionalFinnIngressRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Functional Finn ingress record is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "accountId",
    "bindingId",
    "content",
    "contentDigest",
    "conversationId",
    "conversationKind",
    "ingressId",
    "ordinal",
    "receivedAt",
    "sequence",
    "sourceId",
    "sourceKind",
  ].toSorted();
  if (Object.keys(record).toSorted().join("\0") !== expected.join("\0")) {
    throw new Error("Functional Finn ingress record keys are invalid");
  }
  const sourceKind = record.sourceKind;
  const conversationKind = record.conversationKind;
  if (
    (sourceKind !== "phone" && sourceKind !== "uuid") ||
    (conversationKind !== "direct" && conversationKind !== "group")
  ) {
    throw new Error("Functional Finn ingress kind is invalid");
  }
  return {
    accountId: requiredString(record, "accountId"),
    bindingId: requiredString(record, "bindingId"),
    content: requiredString(record, "content"),
    contentDigest: requiredString(record, "contentDigest"),
    conversationId: requiredString(record, "conversationId"),
    conversationKind,
    ingressId: requiredString(record, "ingressId"),
    ordinal: requiredInteger(record, "ordinal"),
    receivedAt: requiredInteger(record, "receivedAt"),
    sequence: requiredInteger(record, "sequence"),
    sourceId: requiredString(record, "sourceId"),
    sourceKind,
  };
}

function parseResult(body: Buffer, requestId: string): FunctionalFinnIngressRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Functional Finn ingress response is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Functional Finn ingress response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join("\0") !== ["records", "requestId", "schema"].join("\0") ||
    record.schema !== SCHEMA ||
    record.requestId !== requestId ||
    !Array.isArray(record.records)
  ) {
    throw new Error("Functional Finn ingress response binding is invalid");
  }
  if (!Buffer.from(JSON.stringify(canonicalize(record)), "utf8").equals(body)) {
    throw new Error("Functional Finn ingress response is not canonical");
  }
  return record.records.map(parseIngress);
}

export async function pullFunctionalFinnIngress(params: {
  socketPath: string;
  timeoutMs: number;
  requestId: string;
  afterOrdinal: number;
  limit: number;
}): Promise<FunctionalFinnIngressRecord[]> {
  const packet = encodeFunctionalFinnIngressPull(params);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: params.socketPath });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let expected: number | undefined;
    let settled = false;
    const finish = (error?: Error, result?: FunctionalFinnIngressRecord[]) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result ?? []);
      }
    };
    socket.setTimeout(params.timeoutMs, () =>
      finish(new Error("Functional Finn ingress timed out")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PACKET_BYTES + 4) {
        return finish(new Error("Functional Finn ingress response is oversized"));
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks, bytes);
      if (expected === undefined && combined.length >= 4) {
        expected = combined.readUInt32BE(0);
        if (expected > MAX_PACKET_BYTES) {
          return finish(new Error("Functional Finn ingress length is oversized"));
        }
      }
      if (expected !== undefined && combined.length === expected + 4) {
        try {
          finish(undefined, parseResult(combined.subarray(4), params.requestId));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (expected !== undefined && combined.length > expected + 4) {
        finish(new Error("Functional Finn ingress response has trailing bytes"));
      }
    });
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("Functional Finn ingress response is truncated"));
      }
    });
    socket.once("connect", () => socket.end(packet));
  });
}
