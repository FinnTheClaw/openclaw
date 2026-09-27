import {
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  UINT64_MAX,
  type FrameKind,
  type InboundRecord,
  type OutboundSpec,
  type PreparedFrame,
  type PreparedMetadata,
} from "./frame-codec.js";
import type { SessionFault } from "./session-fault.js";

export const MAX_REGISTRATIONS = 4096;
export const MAX_PENDING = 32;
export const MAX_QUEUE_FRAMES = 64;
export const MAX_QUEUE_BYTES = 4_194_304;
export const MAX_CANCEL_SLOTS = 32;
export const RESERVED_QUEUE_BYTES = 4_224;
export const MAX_TRACKED_REQUESTS = 32;
export const MAX_TOMBSTONES = MAX_TRACKED_REQUESTS;
export const TERMINAL_GRACE_NS = 2_000_000_000n;
export const DRAIN_GRACE_NS = 5_000_000_000n;

export type SessionPhase =
  | "NEW"
  | "ATTESTING"
  | "KEYED"
  | "LOAD_PENDING"
  | "LOADING"
  | "REGISTERING"
  | "ACCEPT_PENDING"
  | "ACTIVE"
  | "DRAIN_PENDING"
  | "DRAINING"
  | "STOPPING"
  | "EXIT_VERIFIED"
  | "RECOVERY_REQUIRED";
export type TerminalCause = "result" | "cancel" | "timeout";
export type Lane = "ordinary" | "cancel" | "fatal";
export type Cleanup = Readonly<
  Record<
    | "ingress"
    | "handles"
    | "pending"
    | "channel"
    | "service"
    | "processIdentity"
    | "unitState"
    | "cgroup",
    boolean
  >
>;
export type Pending = Readonly<{
  requestId: string;
  deadlineNs: bigint;
}>;
export type Tombstone = Readonly<{
  requestId: string;
  deadlineNs: bigint;
  cause: TerminalCause;
  expiresNs: bigint;
  loserSeen: boolean;
}>;
export type ResultProof = Readonly<{ kind: "winner-result" | "tombstone-loser" }>;
export type InboundReservation = Readonly<{
  mode: "inbound";
  id: string;
  lane: Lane;
  bytes: number;
  frame: InboundRecord;
  resultProof?: ResultProof;
}>;
export type OutboundReservation = Readonly<{
  mode: "outbound";
  lane: Lane;
  bytes: number;
  token: PreparedFrame;
  metadata: PreparedMetadata;
}>;
export type Reservation = InboundReservation | OutboundReservation;
export type SessionState = {
  phase: SessionPhase;
  readonly generation: bigint;
  readonly channelId: string;
  readonly bootEpoch: string;
  readonly registrationLimit: number;
  registrations: number;
  registrationBytes: number;
  pending: Pending[];
  tombstones: Tombstone[];
  reservations: Reservation[];
  nextSequence: Record<"supervisor-to-worker" | "worker-to-supervisor", bigint | null>;
  cleanup: Cleanup;
  lastNowNs: bigint;
  revision: bigint;
  authorityVersion: bigint;
  drainDeadlineNs?: bigint;
  fault?: SessionFault;
};
export type SessionSnapshot = Readonly<{
  phase: SessionPhase;
  registrationLimit: number;
  registrations: number;
  registrationBytes: number;
  pendingCount: number;
  tombstoneCount: number;
  inboundQueued: number;
  outboundQueued: number;
  cleanupCompleted: number;
  cleanupRequired: number;
  fault?: SessionFault;
}>;
export type SessionAction =
  | Readonly<{ type: "SEND_PREPARED"; frame: PreparedFrame }>
  | Readonly<{
      type: "REJECT_LOCAL_INVOKE";
      reason: "backpressure" | "capacity" | "draining" | "sequence-drain";
    }>
  | Readonly<{ type: "CLOSE_AND_STOP" }>
  | Readonly<{ type: "REJECT_PENDING_AND_FORCE_STOP" }>
  | Readonly<{ type: "DISCARD_LOSING_TERMINAL" }>;
export type ControllerResult = Readonly<{
  snapshot: SessionSnapshot;
  actions: readonly SessionAction[];
}>;
export type SessionEvent =
  | Readonly<{ type: "LOCAL_CONNECTION" }>
  | Readonly<{ type: "LOCAL_ATTESTED" }>
  | Readonly<{
      type: "LOCAL_INVOKE";
      requestId: string;
      deadlineNs: bigint;
      body: Uint8Array;
      nowNs: bigint;
    }>
  | Readonly<{
      type: "LOCAL_TERMINAL";
      requestId: string;
      cause: "cancel" | "timeout";
      nowNs: bigint;
    }>
  | Readonly<{ type: "LOCAL_START_DRAIN"; nowNs: bigint }>
  | Readonly<{ type: "LOCAL_DRAIN_GRACE_EXPIRED"; nowNs: bigint }>
  | Readonly<{ type: "LOCAL_FAULT"; reason: "lifecycle-fault" }>
  | Readonly<{ type: "LOCAL_CLEANUP_PROGRESS"; completed: Partial<Cleanup> }>
  | Readonly<{ type: "LOCAL_EXIT_PROOF" }>
  | Readonly<{ type: "LOCAL_CLEANUP_UNCERTAIN"; reason: "cleanup-uncertain" }>;

export const EMPTY_CLEANUP: Cleanup = Object.freeze({
  ingress: false,
  handles: false,
  pending: false,
  channel: false,
  service: false,
  processIdentity: false,
  unitState: false,
  cgroup: false,
});
const LIVE = new Set<SessionPhase>([
  "NEW",
  "ATTESTING",
  "KEYED",
  "LOAD_PENDING",
  "LOADING",
  "REGISTERING",
  "ACCEPT_PENDING",
  "ACTIVE",
  "DRAIN_PENDING",
  "DRAINING",
]);
const ZERO_REQUEST_ID = "0".repeat(32);

export function createState(params: {
  generation: bigint;
  channelId: string;
  bootEpoch: string;
  registrationLimit?: number;
}): SessionState {
  const registrationLimit = params.registrationLimit ?? MAX_REGISTRATIONS;
  if (
    params.generation < 1n ||
    params.generation > UINT64_MAX ||
    !/^[0-9a-f]{32}$/.test(params.channelId) ||
    !/^[0-9a-f]{32}$/.test(params.bootEpoch) ||
    !Number.isInteger(registrationLimit) ||
    registrationLimit < 0 ||
    registrationLimit > MAX_REGISTRATIONS
  ) {
    throw new Error("invalid-session-identity");
  }
  return {
    phase: "NEW",
    generation: params.generation,
    channelId: params.channelId,
    bootEpoch: params.bootEpoch,
    registrationLimit,
    registrations: 0,
    registrationBytes: 0,
    pending: [],
    tombstones: [],
    reservations: [],
    nextSequence: { "supervisor-to-worker": 1n, "worker-to-supervisor": 1n },
    cleanup: EMPTY_CLEANUP,
    lastNowNs: 0n,
    revision: 1n,
    authorityVersion: 1n,
  };
}

export function snapshot(state: SessionState): SessionSnapshot {
  const cleanup = Object.values(state.cleanup);
  return Object.freeze({
    phase: state.phase,
    registrationLimit: state.registrationLimit,
    registrations: state.registrations,
    registrationBytes: state.registrationBytes,
    pendingCount: state.pending.length,
    tombstoneCount: state.tombstones.length,
    inboundQueued: state.reservations.filter((item) => item.mode === "inbound").length,
    outboundQueued: state.reservations.filter((item) => item.mode === "outbound").length,
    cleanupCompleted: cleanup.filter(Boolean).length,
    cleanupRequired: cleanup.length,
    ...(state.fault === undefined ? {} : { fault: state.fault }),
  });
}

export function touch(state: SessionState): void {
  state.revision += 1n;
}
export function frameId(value: Uint8Array | undefined): string {
  return value ? Buffer.from(value).toString("hex") : "";
}
export function canClaimResult(
  state: SessionState,
  requestId: string,
  deadlineNs: bigint | undefined,
  nowNs: bigint,
): boolean {
  const pending = state.pending.find((item) => item.requestId === requestId);
  if (pending) {
    return pending.deadlineNs === deadlineNs;
  }
  const tombstone = state.tombstones.find((item) => item.requestId === requestId);
  return Boolean(
    tombstone &&
    tombstone.deadlineNs === deadlineNs &&
    tombstone.expiresNs > nowNs &&
    !tombstone.loserSeen &&
    tombstone.cause !== "result",
  );
}
export function claimResult(
  state: SessionState,
  requestId: string,
  deadlineNs: bigint | undefined,
  nowNs: bigint,
): ResultProof | undefined {
  if (!canClaimResult(state, requestId, deadlineNs, nowNs)) {
    return undefined;
  }
  const pending = state.pending.find((item) => item.requestId === requestId);
  if (pending) {
    state.pending = state.pending.filter((item) => item !== pending);
    state.tombstones.push({
      requestId,
      deadlineNs: pending.deadlineNs,
      cause: "result",
      expiresNs: nowNs + TERMINAL_GRACE_NS,
      loserSeen: false,
    });
    return Object.freeze({ kind: "winner-result" });
  }
  const tombstone = state.tombstones.find((item) => item.requestId === requestId)!;
  state.tombstones = state.tombstones.map((item) =>
    item === tombstone ? { ...item, loserSeen: true } : item,
  );
  return Object.freeze({ kind: "tombstone-loser" });
}
export function laneFor(kind: number): Lane {
  return kind === FRAME_KIND.CANCEL ? "cancel" : kind === FRAME_KIND.FATAL ? "fatal" : "ordinary";
}
export function isLivePhase(phase: SessionPhase): boolean {
  return LIVE.has(phase);
}
export function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "EXIT_VERIFIED" || phase === "RECOVERY_REQUIRED";
}
export function isRequestId(value: string): boolean {
  return value !== ZERO_REQUEST_ID && /^[0-9a-f]{32}$/.test(value);
}
export function inboundKindAllowed(phase: SessionPhase, kind: FrameKind): boolean {
  if (kind === FRAME_KIND.FATAL) {
    return LIVE.has(phase);
  }
  if (phase === "KEYED") {
    return kind === FRAME_KIND.SESSION_READY;
  }
  if (phase === "LOADING" || phase === "REGISTERING") {
    return kind === FRAME_KIND.REGISTER || kind === FRAME_KIND.REGISTER_DONE;
  }
  if (phase === "ACTIVE" || phase === "DRAIN_PENDING" || phase === "DRAINING") {
    return kind === FRAME_KIND.RESULT || (phase === "DRAINING" && kind === FRAME_KIND.CLOSE_ACK);
  }
  return false;
}
export function inboundAdmissionFault(
  state: SessionState,
  frame: InboundRecord,
): "authenticated-frame-admission" | "registration-limit" | "early-close-ack" | undefined {
  let phase = state.phase;
  let registrations = state.registrations;
  let registrationBytes = state.registrationBytes;
  for (const item of state.reservations) {
    if (item.mode !== "inbound") {
      continue;
    }
    const queued = item.frame;
    if (!inboundKindAllowed(phase, queued.kind)) {
      return "authenticated-frame-admission";
    }
    if (queued.kind === FRAME_KIND.SESSION_READY) {
      phase = "LOAD_PENDING";
    } else if (queued.kind === FRAME_KIND.REGISTER) {
      phase = "REGISTERING";
      registrations += 1;
      registrationBytes += queued.body?.byteLength ?? 0;
    } else if (queued.kind === FRAME_KIND.REGISTER_DONE) {
      phase = "ACCEPT_PENDING";
    } else if (queued.kind === FRAME_KIND.CLOSE_ACK || queued.kind === FRAME_KIND.FATAL) {
      phase = "STOPPING";
    }
    if (registrations > state.registrationLimit || registrationBytes > MAX_QUEUE_BYTES) {
      return "registration-limit";
    }
  }
  if (!inboundKindAllowed(phase, frame.kind)) {
    return "authenticated-frame-admission";
  }
  if (
    frame.kind === FRAME_KIND.REGISTER &&
    (registrations + 1 > state.registrationLimit ||
      registrationBytes + (frame.body?.byteLength ?? 0) > MAX_QUEUE_BYTES)
  ) {
    return "registration-limit";
  }
  if (
    frame.kind === FRAME_KIND.CLOSE_ACK &&
    (state.pending.length !== 0 || state.reservations.some((item) => item.mode === "outbound"))
  ) {
    return "early-close-ack";
  }
  return undefined;
}
export function requestBusy(state: SessionState, requestId: string): boolean {
  return (
    state.pending.some((item) => item.requestId === requestId) ||
    state.tombstones.some((item) => item.requestId === requestId) ||
    state.reservations.some(
      (item) => item.mode === "outbound" && item.metadata.requestId === requestId,
    )
  );
}
export function hasSequence(state: SessionState, additional = 1, reserveDrain = false): boolean {
  const next = state.nextSequence["supervisor-to-worker"];
  if (next === null) {
    return false;
  }
  return BigInt(additional + (reserveDrain ? 1 : 0)) <= UINT64_MAX - next;
}
export function queueFull(state: SessionState, lane: Lane, bytes: number): boolean {
  const laneItems = state.reservations.filter((item) => item.lane === lane);
  const ordinaryBytes = state.reservations
    .filter((item) => item.lane === "ordinary")
    .reduce((sum, item) => sum + item.bytes, 0);
  const reservedBytes = state.reservations
    .filter((item) => item.lane !== "ordinary")
    .reduce((sum, item) => sum + item.bytes, 0);
  if (lane === "ordinary") {
    return laneItems.length >= MAX_QUEUE_FRAMES || ordinaryBytes + bytes > MAX_QUEUE_BYTES;
  }
  if (lane === "cancel") {
    return (
      laneItems.length >= MAX_CANCEL_SLOTS ||
      bytes !== FRAME_HEADER_BYTES ||
      reservedBytes + bytes > RESERVED_QUEUE_BYTES
    );
  }
  return bytes !== FRAME_HEADER_BYTES || reservedBytes + bytes > RESERVED_QUEUE_BYTES;
}
export function specBytes(spec: OutboundSpec): number {
  return FRAME_HEADER_BYTES + ("body" in spec ? spec.body.byteLength : 0);
}
