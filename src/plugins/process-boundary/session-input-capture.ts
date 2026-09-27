import { FRAME_BODY_CAP, FRAME_HEADER_BYTES, UINT64_MAX } from "./frame-codec.js";
import type { Cleanup } from "./session-state.js";

type CaptureFault =
  | "facet-input"
  | "frame-decode"
  | "invoke-admission"
  | "monotonic-clock"
  | "packet-cap";
export type InputCapture<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "fault"; reason: CaptureFault }>;
type Current = () => boolean;

const ABORTED = Object.freeze({ kind: "aborted" }) as InputCapture<never>;
const CLEANUP_KEYS = [
  "ingress",
  "handles",
  "pending",
  "channel",
  "service",
  "processIdentity",
  "unitState",
  "cgroup",
] as const satisfies readonly (keyof Cleanup)[];

function captured<T>(value: T): InputCapture<T> {
  return Object.freeze({ kind: "ok", value });
}
function captureFault(reason: CaptureFault): InputCapture<never> {
  return Object.freeze({ kind: "fault", reason });
}
function record(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

export function captureInvoke(
  input: unknown,
  current: Current,
): InputCapture<{ requestId: string; deadlineNs: bigint; body: Buffer }> {
  try {
    if (!record(input)) {
      return captureFault("facet-input");
    }
    const requestId = input.requestId;
    if (!current()) {
      return ABORTED;
    }
    const deadlineNs = input.deadlineNs;
    if (!current()) {
      return ABORTED;
    }
    const body = input.body;
    if (!current()) {
      return ABORTED;
    }
    if (
      typeof requestId !== "string" ||
      typeof deadlineNs !== "bigint" ||
      !(body instanceof Uint8Array)
    ) {
      return captureFault("facet-input");
    }
    const bodyLength = body.byteLength;
    if (!current()) {
      return ABORTED;
    }
    if (bodyLength > FRAME_BODY_CAP) {
      return captureFault("invoke-admission");
    }
    const ownedBody = Buffer.from(body);
    if (!current()) {
      return ABORTED;
    }
    return captured(Object.freeze({ requestId, deadlineNs, body: ownedBody }));
  } catch {
    return current() ? captureFault("facet-input") : ABORTED;
  }
}

export function captureTerminal(
  input: unknown,
  current: Current,
): InputCapture<{ requestId: string; cause: "cancel" | "timeout" }> {
  try {
    if (!record(input)) {
      return captureFault("facet-input");
    }
    const requestId = input.requestId;
    if (!current()) {
      return ABORTED;
    }
    const cause = input.cause;
    if (!current()) {
      return ABORTED;
    }
    if (typeof requestId !== "string" || (cause !== "cancel" && cause !== "timeout")) {
      return captureFault("facet-input");
    }
    return captured(Object.freeze({ requestId, cause }));
  } catch {
    return current() ? captureFault("facet-input") : ABORTED;
  }
}

export function captureAdmit(
  packetInput: unknown,
  idInput: unknown,
  current: Current,
): InputCapture<{ packet: Buffer; id: string }> {
  try {
    if (typeof idInput !== "string") {
      return captureFault("facet-input");
    }
    if (!(packetInput instanceof Uint8Array)) {
      return captureFault("frame-decode");
    }
    const packetBytes = packetInput.byteLength;
    if (!current()) {
      return ABORTED;
    }
    if (packetBytes > FRAME_HEADER_BYTES + FRAME_BODY_CAP) {
      return captureFault("packet-cap");
    }
    const packet = Buffer.from(packetInput);
    if (!current()) {
      return ABORTED;
    }
    return captured(Object.freeze({ packet, id: idInput }));
  } catch {
    return current() ? captureFault("frame-decode") : ABORTED;
  }
}

export function captureProcess(
  idInput: unknown,
  optionsInput: unknown,
  current: Current,
): InputCapture<{ id: string; inventoryMatches?: boolean }> {
  try {
    if (typeof idInput !== "string") {
      return captureFault("facet-input");
    }
    if (optionsInput === undefined) {
      return captured(Object.freeze({ id: idInput }));
    }
    if (!record(optionsInput)) {
      return captureFault("facet-input");
    }
    const inventoryMatches = optionsInput.inventoryMatches;
    if (!current()) {
      return ABORTED;
    }
    if (inventoryMatches !== undefined && typeof inventoryMatches !== "boolean") {
      return captureFault("facet-input");
    }
    return captured(
      Object.freeze({
        id: idInput,
        ...(inventoryMatches === undefined ? {} : { inventoryMatches }),
      }),
    );
  } catch {
    return current() ? captureFault("facet-input") : ABORTED;
  }
}

export function captureCleanup(input: unknown, current: Current): InputCapture<Partial<Cleanup>> {
  try {
    if (!record(input)) {
      return captureFault("facet-input");
    }
    const owned: { -readonly [K in keyof Cleanup]?: boolean } = {};
    for (const key of CLEANUP_KEYS) {
      const value = input[key];
      if (!current()) {
        return ABORTED;
      }
      if (value !== undefined && typeof value !== "boolean") {
        return captureFault("facet-input");
      }
      if (value !== undefined) {
        owned[key] = value;
      }
    }
    return captured(Object.freeze(owned));
  } catch {
    return current() ? captureFault("facet-input") : ABORTED;
  }
}

export function captureClock(nowNs: () => unknown, current: Current): InputCapture<bigint> {
  try {
    const value = nowNs();
    if (!current()) {
      return ABORTED;
    }
    return typeof value === "bigint" && value >= 0n && value <= UINT64_MAX
      ? captured(value)
      : captureFault("monotonic-clock");
  } catch {
    return current() ? captureFault("monotonic-clock") : ABORTED;
  }
}
