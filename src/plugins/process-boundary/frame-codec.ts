import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { encodeKeyInstall } from "./bootstrap-codec.js";
import { createBoundFrameStore } from "./frame-token-store.js";

export type { PreparedFrame } from "./frame-token-store.js";
export const FRAME_HEADER_BYTES = 128;
export const FRAME_BODY_CAP = 1_048_576;
export const REGISTER_BODY_CAP = 262_144;
export const MAX_DEADLINE_AHEAD_NS = 300_000_000_000n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const FRAME_KIND = {
  SESSION_READY: 0x01,
  LOAD_PACKAGE: 0x02,
  REGISTER: 0x03,
  REGISTER_DONE: 0x04,
  REGISTER_ACCEPT: 0x05,
  INVOKE: 0x10,
  RESULT: 0x11,
  CANCEL: 0x12,
  DRAIN: 0x20,
  CLOSE_ACK: 0x21,
  FATAL: 0x7f,
} as const;
export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];
export type FrameDirection = "supervisor-to-worker" | "worker-to-supervisor";
type RequestRule = "zero" | "invoke" | "related";
type KindMetadata = Readonly<{
  direction: FrameDirection;
  bodyCap: number;
  bodyless: boolean;
  request: RequestRule;
}>;
export type Frame = Readonly<{
  kind: FrameKind;
  channelId: Uint8Array;
  bootEpoch: Uint8Array;
  generation: bigint;
  sequence: bigint;
  requestId?: Uint8Array;
  deadlineNs?: bigint;
  body?: Uint8Array;
}>;
export type OutboundSpec =
  | Readonly<{
      kind:
        | typeof FRAME_KIND.LOAD_PACKAGE
        | typeof FRAME_KIND.REGISTER_ACCEPT
        | typeof FRAME_KIND.DRAIN;
    }>
  | Readonly<{
      kind: typeof FRAME_KIND.INVOKE;
      requestId: Uint8Array;
      deadlineNs: bigint;
      body: Uint8Array;
    }>
  | Readonly<{ kind: typeof FRAME_KIND.CANCEL; requestId: Uint8Array; deadlineNs: bigint }>;
export type InboundRecord = Frame & Readonly<{ direction: "worker-to-supervisor" }>;
export type PreparedMetadata = Readonly<{
  kind: OutboundSpec["kind"];
  generation: bigint;
  sequence: bigint;
  requestId?: string;
  deadlineNs?: bigint;
  bodyLength: number;
  packetBytes: number;
  installRevision: bigint;
  controllerVersion: bigint;
}>;

export class FrameProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FrameProtocolError";
  }
}

const BOUNDED_FRAME_FAULTS = [
  "body-cap",
  "bodyless-kind",
  "boot-epoch",
  "boot-epoch-length",
  "channel-id",
  "channel-id-length",
  "control-request-binding",
  "deadline",
  "direction",
  "generation",
  "generation-fenced",
  "generation-mismatch",
  "key-length",
  "key-not-installed",
  "kind",
  "mac",
  "magic",
  "missing-request-binding",
  "now",
  "packet-cap",
  "packet-length",
  "request-id-length",
  "reserved",
  "retained-request-binding",
  "sequence",
  "sequence-exhausted",
  "sequence-mismatch",
  "truncated-header",
  "version",
] as const;
export type FrameFaultReason = (typeof BOUNDED_FRAME_FAULTS)[number];
const BOUNDED_FRAME_FAULT_SET: ReadonlySet<string> = new Set(BOUNDED_FRAME_FAULTS);

export function frameFaultReason(error: unknown): FrameFaultReason | "frame-decode" {
  return error instanceof FrameProtocolError && BOUNDED_FRAME_FAULT_SET.has(error.code)
    ? (error.code as FrameFaultReason)
    : "frame-decode";
}

const MAGIC = Buffer.from("OCPB", "ascii");
const ZERO_16 = Buffer.alloc(16);
const ZERO_8 = Buffer.alloc(8);
const S2W = "supervisor-to-worker" as const;
const W2S = "worker-to-supervisor" as const;
const KINDS: Readonly<Record<FrameKind, KindMetadata>> = {
  [FRAME_KIND.SESSION_READY]: { direction: W2S, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.LOAD_PACKAGE]: { direction: S2W, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.REGISTER]: {
    direction: W2S,
    bodyCap: REGISTER_BODY_CAP,
    bodyless: false,
    request: "zero",
  },
  [FRAME_KIND.REGISTER_DONE]: { direction: W2S, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.REGISTER_ACCEPT]: { direction: S2W, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.INVOKE]: {
    direction: S2W,
    bodyCap: FRAME_BODY_CAP,
    bodyless: false,
    request: "invoke",
  },
  [FRAME_KIND.RESULT]: {
    direction: W2S,
    bodyCap: FRAME_BODY_CAP,
    bodyless: false,
    request: "related",
  },
  [FRAME_KIND.CANCEL]: { direction: S2W, bodyCap: 0, bodyless: true, request: "related" },
  [FRAME_KIND.DRAIN]: { direction: S2W, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.CLOSE_ACK]: { direction: W2S, bodyCap: 0, bodyless: true, request: "zero" },
  [FRAME_KIND.FATAL]: { direction: W2S, bodyCap: 0, bodyless: true, request: "zero" },
};

function fail(code: string): never {
  throw new FrameProtocolError(code);
}
function exact(value: Uint8Array, length: number, code: string): Buffer {
  if (value.byteLength !== length) {
    fail(code);
  }
  return Buffer.from(value);
}
function u64(value: bigint, code: string, allowZero = false): void {
  if (value < (allowZero ? 0n : 1n) || value > UINT64_MAX) {
    fail(code);
  }
}
function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function validateRequest(
  rule: RequestRule,
  requestId: Buffer,
  deadlineNs: bigint,
  nowNs: bigint,
  binding?: Readonly<{ requestId: Uint8Array; deadlineNs: bigint }>,
): void {
  const present = !requestId.equals(ZERO_16);
  if (rule === "zero") {
    if (present || deadlineNs !== 0n) {
      fail("control-request-binding");
    }
    return;
  }
  if (!present || deadlineNs === 0n) {
    fail("missing-request-binding");
  }
  if (rule === "invoke") {
    if (deadlineNs <= nowNs || deadlineNs - nowNs > MAX_DEADLINE_AHEAD_NS) {
      fail("invoke-deadline");
    }
  } else if (
    binding &&
    (!same(requestId, binding.requestId) || deadlineNs !== binding.deadlineNs)
  ) {
    fail("retained-request-binding");
  }
}
function validateSemantic(params: {
  kind: FrameKind;
  direction: FrameDirection;
  generation: bigint;
  sequence: bigint;
  requestId: Buffer;
  deadlineNs: bigint;
  bodyLength: number;
  nowNs: bigint;
  binding?: Readonly<{ requestId: Uint8Array; deadlineNs: bigint }>;
}): void {
  const metadata = KINDS[params.kind];
  if (!metadata) {
    fail("kind");
  }
  u64(params.generation, "generation");
  u64(params.sequence, "sequence");
  if (params.sequence === UINT64_MAX) {
    fail("sequence-exhausted");
  }
  u64(params.deadlineNs, "deadline", true);
  u64(params.nowNs, "now", true);
  if (metadata.direction !== params.direction) {
    fail("direction");
  }
  if (metadata.bodyless && params.bodyLength !== 0) {
    fail("bodyless-kind");
  }
  if (params.bodyLength > metadata.bodyCap) {
    fail("body-cap");
  }
  validateRequest(
    metadata.request,
    params.requestId,
    params.deadlineNs,
    params.nowNs,
    params.binding,
  );
}

function encodeRaw(
  frame: Frame,
  direction: FrameDirection,
  key: Uint8Array,
  nowNs: bigint,
  binding?: Readonly<{ requestId: Uint8Array; deadlineNs: bigint }>,
): Buffer {
  const body = Buffer.from(frame.body ?? []);
  const requestId = exact(frame.requestId ?? ZERO_16, 16, "request-id-length");
  const channelId = exact(frame.channelId, 16, "channel-id-length");
  const bootEpoch = exact(frame.bootEpoch, 16, "boot-epoch-length");
  const ownedKey = exact(key, 32, "key-length");
  try {
    const deadlineNs = frame.deadlineNs ?? 0n;
    validateSemantic({
      kind: frame.kind,
      direction,
      generation: frame.generation,
      sequence: frame.sequence,
      requestId,
      deadlineNs,
      bodyLength: body.length,
      nowNs,
      ...(binding ? { binding } : {}),
    });
    const packet = Buffer.alloc(FRAME_HEADER_BYTES + body.length);
    MAGIC.copy(packet);
    packet.writeUInt16BE(1, 4);
    packet[6] = frame.kind;
    packet.writeUInt32BE(body.length, 12);
    channelId.copy(packet, 16);
    bootEpoch.copy(packet, 32);
    packet.writeBigUInt64BE(frame.generation, 48);
    packet.writeBigUInt64BE(frame.sequence, 56);
    requestId.copy(packet, 64);
    packet.writeBigUInt64BE(deadlineNs, 80);
    body.copy(packet, FRAME_HEADER_BYTES);
    createHmac("sha256", ownedKey)
      .update(packet.subarray(0, 96))
      .update(body)
      .digest()
      .copy(packet, 96);
    return packet;
  } finally {
    ownedKey.fill(0);
  }
}

export function encodeWorkerFrame(
  frame: Frame,
  context: Readonly<{
    key: Uint8Array;
    nowNs: bigint;
    requestBinding?: Readonly<{ requestId: Uint8Array; deadlineNs: bigint }>;
  }>,
): Buffer {
  return encodeRaw(frame, W2S, context.key, context.nowNs, context.requestBinding);
}

/** @internal Every call mints a fresh authority for one disjoint generation kernel. */
export function createGenerationCodec(params: { bootEpoch: Uint8Array; generation: bigint }) {
  const channelId = randomBytes(16);
  const bootEpoch = exact(params.bootEpoch, 16, "boot-epoch-length");
  u64(params.generation, "generation");
  const store = createBoundFrameStore<PreparedMetadata>();
  let key: Buffer | undefined;
  let keyInstallPacket: Buffer | undefined;
  let fenced = false;
  let keyInstallState: "idle" | "delivering" | "installed" | "fenced" = "idle";

  function fenceGeneration(): void {
    if (!fenced) {
      fenced = true;
      store.fence();
    }
    key?.fill(0);
    key = undefined;
    keyInstallPacket?.fill(0);
    keyInstallPacket = undefined;
    keyInstallState = "fenced";
  }

  function deliverKeyInstall(deliver: (packet: Buffer) => boolean): void {
    if (fenced || keyInstallState !== "idle") {
      fenceGeneration();
      fail("key-install-state");
    }
    keyInstallState = "delivering";
    try {
      key = randomBytes(32);
      keyInstallPacket = encodeKeyInstall({
        channelId,
        bootEpoch,
        generation: params.generation,
        key,
      });
      if (deliver(keyInstallPacket) !== true || fenced || keyInstallState !== "delivering") {
        fail("key-install-rejected");
      }
      keyInstallState = "installed";
    } catch (error) {
      fenceGeneration();
      throw error;
    } finally {
      keyInstallPacket?.fill(0);
      keyInstallPacket = undefined;
    }
  }
  function installedKey(): Buffer {
    if (keyInstallState !== "installed" || !key) {
      fail("key-not-installed");
    }
    return key;
  }

  function decodeInbound(
    packetBytes: Uint8Array,
    expectedSequence: bigint,
    nowNs: bigint,
    binding?: Readonly<{ requestId: Uint8Array; deadlineNs: bigint }>,
  ): InboundRecord {
    if (fenced) {
      fail("generation-fenced");
    }
    if (packetBytes.byteLength < FRAME_HEADER_BYTES) {
      fail("truncated-header");
    }
    if (packetBytes.byteLength > FRAME_HEADER_BYTES + FRAME_BODY_CAP) {
      fail("packet-cap");
    }
    const packet = Buffer.from(packetBytes);
    if (!packet.subarray(0, 4).equals(MAGIC)) {
      fail("magic");
    }
    if (packet.readUInt16BE(4) !== 1) {
      fail("version");
    }
    const bodyLength = packet.readUInt32BE(12);
    if (packet.length !== FRAME_HEADER_BYTES + bodyLength) {
      fail("packet-length");
    }
    const tag = createHmac("sha256", installedKey())
      .update(packet.subarray(0, 96))
      .update(packet.subarray(FRAME_HEADER_BYTES))
      .digest();
    if (!timingSafeEqual(packet.subarray(96, 128), tag)) {
      fail("mac");
    }
    const rawKind = packet[6];
    if (!Object.hasOwn(KINDS, rawKind)) {
      fail("kind");
    }
    const kind = rawKind as FrameKind;
    if (
      packet[7] !== 0 ||
      packet.readUInt32BE(8) !== 0 ||
      !packet.subarray(88, 96).equals(ZERO_8)
    ) {
      fail("reserved");
    }
    if (!same(packet.subarray(16, 32), channelId)) {
      fail("channel-id");
    }
    if (!same(packet.subarray(32, 48), bootEpoch)) {
      fail("boot-epoch");
    }
    const generation = packet.readBigUInt64BE(48);
    const sequence = packet.readBigUInt64BE(56);
    const requestId = packet.subarray(64, 80);
    const deadlineNs = packet.readBigUInt64BE(80);
    if (generation !== params.generation) {
      fail("generation-mismatch");
    }
    if (sequence !== expectedSequence) {
      fail("sequence-mismatch");
    }
    validateSemantic({
      kind,
      direction: W2S,
      generation,
      sequence,
      requestId,
      deadlineNs,
      bodyLength,
      nowNs,
      ...(binding ? { binding } : {}),
    });
    return Object.freeze({
      kind,
      direction: W2S,
      channelId: Buffer.from(channelId),
      bootEpoch: Buffer.from(bootEpoch),
      generation,
      sequence,
      ...(requestId.equals(ZERO_16) ? {} : { requestId: Buffer.from(requestId) }),
      ...(deadlineNs === 0n ? {} : { deadlineNs }),
      body: Buffer.from(packet.subarray(FRAME_HEADER_BYTES)),
    });
  }

  function prepare(
    spec: OutboundSpec,
    sequence: bigint,
    nowNs: bigint,
    installRevision: bigint,
    controllerVersion: bigint,
  ) {
    if (fenced) {
      fail("generation-fenced");
    }
    const requestId =
      "requestId" in spec ? exact(spec.requestId, 16, "request-id-length") : undefined;
    const deadlineNs = "deadlineNs" in spec ? spec.deadlineNs : undefined;
    const body = "body" in spec ? Buffer.from(spec.body) : Buffer.alloc(0);
    const packet = encodeRaw(
      {
        kind: spec.kind,
        channelId,
        bootEpoch,
        generation: params.generation,
        sequence,
        ...(requestId ? { requestId } : {}),
        ...(deadlineNs !== undefined ? { deadlineNs } : {}),
        body,
      },
      S2W,
      installedKey(),
      nowNs,
      spec.kind === FRAME_KIND.CANCEL
        ? { requestId: requestId!, deadlineNs: deadlineNs! }
        : undefined,
    );
    const metadata: PreparedMetadata = Object.freeze({
      kind: spec.kind,
      generation: params.generation,
      sequence,
      ...(requestId ? { requestId: requestId.toString("hex") } : {}),
      ...(deadlineNs !== undefined ? { deadlineNs } : {}),
      bodyLength: body.length,
      packetBytes: packet.length,
      installRevision,
      controllerVersion,
    });
    return Object.freeze({ token: store.mint(metadata, packet), metadata });
  }

  return Object.freeze({
    channelId: Buffer.from(channelId),
    deliverKeyInstall,
    decodeInbound,
    prepare,
    take: store.take,
    commit: store.commit,
    currentFence: store.currentFence,
    fence: fenceGeneration,
  });
}
