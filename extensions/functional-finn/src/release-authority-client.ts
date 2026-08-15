import { createHash } from "node:crypto";
import net from "node:net";

const SCHEMA = "functional-finn.release-ipc.v1" as const;
const MAX_PACKET_BYTES = 256 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExternalEvidenceReference = {
  kind: "signal_ingress";
  ingressId: string;
  startByte: number;
  endByte: number;
  quote: string;
  receiptId: null;
};

export type ExternalCandidate = {
  candidateId: string;
  turnTicket: string;
  revision: 0 | 1;
  ingressId: string;
  bindingId: string;
  responseClass: "factual" | "non_factual_ack";
  message: string;
  claims: Array<{ claimId: string; text: string; evidence: ExternalEvidenceReference[] }>;
};

export type ExternalCandidateResult = {
  requestId: string;
  candidateId: string;
  status: "validated" | "revision_required" | "delivered" | "unknown" | "abstained" | "denied";
  frameId: string | null;
  messageId: string | null;
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

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

export function digestFunctionalFinnCandidate(candidate: ExternalCandidate): string {
  return createHash("sha256").update(canonicalBytes(candidate)).digest("hex");
}

export function encodeFunctionalFinnCandidateValidation(params: {
  requestId: string;
  candidate: ExternalCandidate;
}): Buffer {
  const body = canonicalBytes({
    candidate: params.candidate,
    op: "candidate.validate",
    requestId: params.requestId,
    schema: SCHEMA,
  });
  if (body.length > MAX_PACKET_BYTES) {
    throw new Error("Functional Finn candidate IPC request is oversized");
  }
  const packet = Buffer.allocUnsafe(4 + body.length);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

export function encodeFunctionalFinnCandidateRelease(params: {
  requestId: string;
  candidate: ExternalCandidate;
}): Buffer {
  const body = canonicalBytes({
    candidateDigest: digestFunctionalFinnCandidate(params.candidate),
    candidateId: params.candidate.candidateId,
    message: params.candidate.message,
    op: "candidate.release",
    requestId: params.requestId,
    revision: params.candidate.revision,
    schema: SCHEMA,
    turnTicket: params.candidate.turnTicket,
  });
  if (body.length > MAX_PACKET_BYTES) {
    throw new Error("Functional Finn candidate release request is oversized");
  }
  const packet = Buffer.allocUnsafe(4 + body.length);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

function parseResult(
  body: Buffer,
  requestId: string,
  candidateId: string,
): ExternalCandidateResult {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Functional Finn authority returned malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Functional Finn authority response is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (
    keys.join("\0") !==
      ["candidateId", "frameId", "messageId", "requestId", "schema", "status"].join("\0") ||
    record.schema !== SCHEMA ||
    record.requestId !== requestId ||
    record.candidateId !== candidateId ||
    !["validated", "revision_required", "delivered", "unknown", "abstained", "denied"].includes(
      record.status as string,
    ) ||
    (record.frameId !== null && typeof record.frameId !== "string") ||
    (record.messageId !== null && typeof record.messageId !== "string")
  ) {
    throw new Error("Functional Finn authority response binding is invalid");
  }
  const canonical = Buffer.from(JSON.stringify(canonicalize(record)), "utf8");
  if (!canonical.equals(body)) {
    throw new Error("Functional Finn authority response is not canonical");
  }
  return record as ExternalCandidateResult;
}

async function requestFunctionalFinnCandidate(params: {
  socketPath: string;
  timeoutMs: number;
  requestId: string;
  candidate: ExternalCandidate;
  packet: Buffer;
}): Promise<ExternalCandidateResult> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: params.socketPath });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let expected: number | undefined;
    let settled = false;
    const finish = (error?: Error, result?: ExternalCandidateResult) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result as ExternalCandidateResult);
      }
    };
    socket.setTimeout(params.timeoutMs, () =>
      finish(new Error("Functional Finn authority timed out")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PACKET_BYTES + 4) {
        finish(new Error("Functional Finn authority response is oversized"));
        return;
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks, bytes);
      if (expected === undefined && combined.length >= 4) {
        expected = combined.readUInt32BE(0);
        if (expected > MAX_PACKET_BYTES) {
          finish(new Error("Functional Finn authority response length is oversized"));
          return;
        }
      }
      if (expected !== undefined && combined.length === expected + 4) {
        try {
          finish(
            undefined,
            parseResult(combined.subarray(4), params.requestId, params.candidate.candidateId),
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (expected !== undefined && combined.length > expected + 4) {
        finish(new Error("Functional Finn authority response has trailing bytes"));
      }
    });
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("Functional Finn authority response is truncated"));
      }
    });
    socket.once("connect", () => socket.end(params.packet));
  });
}

export async function validateFunctionalFinnCandidate(params: {
  socketPath: string;
  timeoutMs: number;
  requestId: string;
  candidate: ExternalCandidate;
}): Promise<ExternalCandidateResult> {
  return await requestFunctionalFinnCandidate({
    ...params,
    packet: encodeFunctionalFinnCandidateValidation(params),
  });
}

export async function releaseFunctionalFinnCandidate(params: {
  socketPath: string;
  timeoutMs: number;
  requestId: string;
  candidate: ExternalCandidate;
}): Promise<ExternalCandidateResult> {
  return await requestFunctionalFinnCandidate({
    ...params,
    packet: encodeFunctionalFinnCandidateRelease(params),
  });
}
