import { createHmac } from "node:crypto";
import { expect } from "vitest";
import {
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  FrameProtocolError,
  encodeWorkerFrame,
  type Frame,
  type FrameKind,
} from "./frame-codec.js";

export {
  FRAME_BODY_CAP,
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  MAX_DEADLINE_AHEAD_NS,
  REGISTER_BODY_CAP,
  UINT64_MAX,
  encodeWorkerFrame,
} from "./frame-codec.js";

export const key = Buffer.alloc(32, 0xa5);
export const channelId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
export const bootEpoch = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
export const requestId = Buffer.from("1234567890abcdef1234567890abcdef", "hex");
export const nowNs = 10_000n;
export const deadlineNs = 20_000n;

const REQUEST_KINDS = new Set<FrameKind>([FRAME_KIND.RESULT]);

export function frame(kind: FrameKind, body: Uint8Array = Buffer.alloc(0)): Frame {
  const requestBearing = REQUEST_KINDS.has(kind);
  return {
    kind,
    channelId,
    bootEpoch,
    generation: 0x0102030405060708n,
    sequence: 0x1112131415161718n,
    ...(requestBearing ? { requestId, deadlineNs } : {}),
    body,
  };
}
export function packet(kind: FrameKind, body: Uint8Array = Buffer.alloc(0)): Buffer {
  return encodeWorkerFrame(frame(kind, body), {
    key,
    nowNs,
    ...(kind === FRAME_KIND.RESULT ? { requestBinding: { requestId, deadlineNs } } : {}),
  });
}
export function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected protocol error");
  } catch (error) {
    expect(error).toBeInstanceOf(FrameProtocolError);
    expect((error as FrameProtocolError).code).toBe(code);
  }
}
export function retag(value: Buffer): void {
  createHmac("sha256", key)
    .update(value.subarray(0, 96))
    .update(value.subarray(FRAME_HEADER_BYTES))
    .digest()
    .copy(value, 96);
}
