import { createHash } from "node:crypto";
import net from "node:net";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveFunctionalFinnExternalAuthority } from "./functional-finn-external-config.js";

const SCHEMA = "functional-finn.release-ipc.v1" as const;
const MAX_PACKET_BYTES = 256 * 1024;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Candidate = {
  candidateId: string;
  turnTicket: string;
  revision: 0 | 1;
  ingressId: string;
  bindingId: string;
  responseClass: "factual" | "non_factual_ack";
  message: string;
  claims: unknown[];
};

export type FunctionalFinnExternalEscrow = {
  kind: "external_release_escrow";
  candidate: Candidate;
  candidateDigest: string;
};

type ReleaseResult = {
  candidateId: string;
  frameId: string | null;
  messageId: string | null;
  requestId: string;
  schema: typeof SCHEMA;
  status: "validated" | "revision_required" | "delivered" | "unknown" | "abstained" | "denied";
};

function canonicalize(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Functional Finn IPC number is invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Functional Finn IPC value is invalid");
  }
  const output: Record<string, Json> = {};
  for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
    output[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return output;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function parseEscrow(value: unknown): FunctionalFinnExternalEscrow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).toSorted().join("\0") !== "candidate\0candidateDigest\0kind" ||
    root.kind !== "external_release_escrow" ||
    typeof root.candidateDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(root.candidateDigest) ||
    !root.candidate ||
    typeof root.candidate !== "object" ||
    Array.isArray(root.candidate)
  ) {
    return undefined;
  }
  const candidate = root.candidate as Record<string, unknown>;
  const expected = [
    "bindingId",
    "candidateId",
    "claims",
    "ingressId",
    "message",
    "responseClass",
    "revision",
    "turnTicket",
  ].toSorted();
  if (
    Object.keys(candidate).toSorted().join("\0") !== expected.join("\0") ||
    ![
      candidate.bindingId,
      candidate.candidateId,
      candidate.ingressId,
      candidate.message,
      candidate.turnTicket,
    ].every((item) => typeof item === "string" && item.length > 0) ||
    (candidate.revision !== 0 && candidate.revision !== 1) ||
    (candidate.responseClass !== "factual" && candidate.responseClass !== "non_factual_ack") ||
    !Array.isArray(candidate.claims)
  ) {
    return undefined;
  }
  const digest = createHash("sha256").update(canonicalBytes(candidate)).digest("hex");
  if (digest !== root.candidateDigest) {
    return undefined;
  }
  return root as FunctionalFinnExternalEscrow;
}

function encodeRelease(requestId: string, escrow: FunctionalFinnExternalEscrow): Buffer {
  const candidate = escrow.candidate;
  const body = canonicalBytes({
    candidateDigest: escrow.candidateDigest,
    candidateId: candidate.candidateId,
    message: candidate.message,
    op: "candidate.release",
    requestId,
    revision: candidate.revision,
    schema: SCHEMA,
    turnTicket: candidate.turnTicket,
  });
  if (body.length > MAX_PACKET_BYTES) {
    throw new Error("Functional Finn release request is oversized");
  }
  const packet = Buffer.allocUnsafe(body.length + 4);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

function parseResult(body: Buffer, requestId: string, candidateId: string): ReleaseResult {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Functional Finn release response is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Functional Finn release response is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = ["candidateId", "frameId", "messageId", "requestId", "schema", "status"];
  const statuses = [
    "validated",
    "revision_required",
    "delivered",
    "unknown",
    "abstained",
    "denied",
  ];
  if (
    Object.keys(record).toSorted().join("\0") !== keys.join("\0") ||
    record.schema !== SCHEMA ||
    record.requestId !== requestId ||
    record.candidateId !== candidateId ||
    !statuses.includes(record.status as string) ||
    (record.frameId !== null && typeof record.frameId !== "string") ||
    (record.messageId !== null && typeof record.messageId !== "string") ||
    !canonicalBytes(record).equals(body)
  ) {
    throw new Error("Functional Finn release response binding is invalid");
  }
  return record as ReleaseResult;
}

async function release(params: {
  socketPath: string;
  timeoutMs: number;
  requestId: string;
  escrow: FunctionalFinnExternalEscrow;
}): Promise<ReleaseResult> {
  const packet = encodeRelease(params.requestId, params.escrow);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: params.socketPath });
    const chunks: Buffer[] = [];
    let total = 0;
    let expected: number | undefined;
    let settled = false;
    const finish = (error?: Error, result?: ReleaseResult) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result as ReleaseResult);
      }
    };
    socket.setTimeout(params.timeoutMs, () =>
      finish(new Error("Functional Finn release timed out")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_PACKET_BYTES + 4) {
        return finish(new Error("Functional Finn release response is oversized"));
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks, total);
      if (expected === undefined && combined.length >= 4) {
        expected = combined.readUInt32BE(0);
        if (expected > MAX_PACKET_BYTES) {
          return finish(new Error("Functional Finn release response length is oversized"));
        }
      }
      if (expected !== undefined && combined.length === expected + 4) {
        try {
          finish(
            undefined,
            parseResult(
              combined.subarray(4),
              params.requestId,
              params.escrow.candidate.candidateId,
            ),
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (expected !== undefined && combined.length > expected + 4) {
        finish(new Error("Functional Finn release response has trailing bytes"));
      }
    });
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("Functional Finn release response is truncated"));
      }
    });
    socket.once("connect", () => socket.end(packet));
  });
}

export async function sendProtectedFunctionalFinnSignal(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  text: string;
  channelData?: Record<string, unknown>;
}) {
  const authority = resolveFunctionalFinnExternalAuthority({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!authority) {
    throw new Error("Functional Finn external authority is not enabled");
  }
  const escrow = parseEscrow(params.channelData?.functionalFinnExternalEscrow);
  if (!escrow || escrow.candidate.message !== params.text) {
    throw new Error("Protected Signal delivery requires an exact validated Functional Finn escrow");
  }
  const requestId = `release:${escrow.candidate.candidateId}`;
  const result = await release({
    socketPath: authority.candidateSocketPath,
    timeoutMs: authority.timeoutMs,
    requestId,
    escrow,
  });
  if (result.status !== "delivered" || !result.messageId) {
    throw new Error(`Protected Signal external release failed closed (${result.status})`);
  }
  return {
    messageId: result.messageId,
    receipt: createMessageReceiptFromOutboundResults({
      kind: "text",
      results: [
        {
          channel: "signal",
          messageId: result.messageId,
          meta: { externalFrameId: result.frameId },
        },
      ],
    }),
  };
}
