import { FRAME_HEADER_BYTES, FRAME_KIND, UINT64_MAX, type InboundRecord } from "./frame-codec.js";
import { frameFaultReason } from "./frame-codec.js";
import type { SessionFault } from "./session-fault.js";
import {
  MAX_QUEUE_BYTES,
  canClaimResult,
  claimResult,
  frameId,
  hasSequence,
  inboundAdmissionFault,
  inboundKindAllowed,
  isLivePhase,
  laneFor,
  queueFull,
  touch,
  type ControllerResult,
  type InboundReservation,
  type SessionAction,
  type SessionState,
} from "./session-state.js";
import { processResultProof } from "./session-terminal.js";

type ProcessOptions = Readonly<{ nowNs?: bigint; inventoryMatches?: boolean }>;

export function createInboundEngine(deps: {
  state(): SessionState;
  decode(packet: Uint8Array, sequence: bigint, nowNs: bigint): InboundRecord;
  advanceNow(nowNs: bigint): readonly SessionAction[] | undefined;
  fault(reason: SessionFault): readonly SessionAction[];
  recover(reason: SessionFault): readonly SessionAction[];
  close(): readonly SessionAction[];
  finish(actions?: readonly SessionAction[]): ControllerResult;
  install(
    kind:
      | typeof FRAME_KIND.LOAD_PACKAGE
      | typeof FRAME_KIND.REGISTER_ACCEPT
      | typeof FRAME_KIND.DRAIN,
    nowNs: bigint,
  ): readonly SessionAction[];
}) {
  function admit(packet: Uint8Array, id: string, nowNs: bigint): ControllerResult {
    const state = deps.state();
    if (state.phase === "STOPPING") {
      return deps.finish(deps.recover("post-stop-frame"));
    }
    if (!isLivePhase(state.phase)) {
      return deps.finish();
    }
    const timeFault = deps.advanceNow(nowNs);
    if (timeFault) {
      return deps.finish(timeFault);
    }
    const expected = state.nextSequence["worker-to-supervisor"];
    if (
      !id ||
      expected === null ||
      state.reservations.some((item) => item.mode === "inbound" && item.id === id)
    ) {
      return deps.finish(deps.fault("authenticated-frame-admission"));
    }
    try {
      const frame = deps.decode(packet, expected, nowNs);
      const admissionFault = inboundAdmissionFault(state, frame);
      if (admissionFault) {
        return deps.finish(deps.fault(admissionFault));
      }
      const resultId = frame.kind === FRAME_KIND.RESULT ? frameId(frame.requestId) : undefined;
      if (frame.kind === FRAME_KIND.RESULT) {
        if (!canClaimResult(state, resultId!, frame.deadlineNs, nowNs)) {
          return deps.finish(deps.fault("authenticated-request-binding"));
        }
      }
      const lane = laneFor(frame.kind);
      const bytes = FRAME_HEADER_BYTES + (frame.body?.byteLength ?? 0);
      if (queueFull(state, lane, bytes)) {
        return deps.finish(deps.fault("queue-cap"));
      }
      const exhausted = frame.sequence === UINT64_MAX - 1n;
      if (exhausted && (state.phase !== "ACTIVE" || !hasSequence(state))) {
        return deps.finish(deps.fault("inbound-sequence-exhausted"));
      }
      if (frame.kind === FRAME_KIND.FATAL) {
        return deps.finish(deps.fault("peer-fatal"));
      }
      const resultProof = resultId
        ? claimResult(state, resultId, frame.deadlineNs, nowNs)
        : undefined;
      if (resultId && !resultProof) {
        return deps.finish(deps.fault("result-claim-race"));
      }
      state.nextSequence["worker-to-supervisor"] = exhausted ? null : expected + 1n;
      state.reservations.push(
        Object.freeze({
          mode: "inbound",
          id,
          lane,
          bytes,
          frame,
          ...(resultProof ? { resultProof } : {}),
        }),
      );
      touch(state);
      if (!exhausted) {
        return deps.finish();
      }
      state.phase = "DRAIN_PENDING";
      touch(state);
      return deps.finish(deps.install(FRAME_KIND.DRAIN, nowNs));
    } catch (error) {
      return deps.finish(deps.fault(frameFaultReason(error)));
    }
  }

  function process(id: string, options: ProcessOptions = {}): ControllerResult {
    const state = deps.state();
    if (state.phase === "STOPPING" || !isLivePhase(state.phase)) {
      return deps.finish();
    }
    if (options.nowNs !== undefined) {
      const timeFault = deps.advanceNow(options.nowNs);
      if (timeFault) {
        return deps.finish(timeFault);
      }
    }
    const first = state.reservations.find(
      (item): item is InboundReservation => item.mode === "inbound",
    );
    if (!first || first.id !== id) {
      return deps.finish(deps.fault("inbound-fifo"));
    }
    if (!inboundKindAllowed(state.phase, first.frame.kind)) {
      return deps.finish(deps.fault("queued-kind-no-longer-legal"));
    }
    state.reservations = state.reservations.filter((item) => item !== first);
    touch(state);
    const frame = first.frame;
    if (frame.kind === FRAME_KIND.SESSION_READY) {
      state.phase = "LOAD_PENDING";
      touch(state);
      return deps.finish(deps.install(FRAME_KIND.LOAD_PACKAGE, state.lastNowNs));
    }
    if (frame.kind === FRAME_KIND.REGISTER) {
      const bytes = state.registrationBytes + (frame.body?.byteLength ?? 0);
      if (state.registrations >= state.registrationLimit || bytes > MAX_QUEUE_BYTES) {
        return deps.finish(deps.fault("registration-limit"));
      }
      state.phase = "REGISTERING";
      state.registrations += 1;
      state.registrationBytes = bytes;
      touch(state);
      return deps.finish();
    }
    if (frame.kind === FRAME_KIND.REGISTER_DONE) {
      if (options.inventoryMatches !== true) {
        return deps.finish(deps.fault("registration-inventory"));
      }
      state.phase = "ACCEPT_PENDING";
      touch(state);
      return deps.finish(deps.install(FRAME_KIND.REGISTER_ACCEPT, state.lastNowNs));
    }
    if (frame.kind === FRAME_KIND.RESULT) {
      return deps.finish(processResultProof(first.resultProof, deps.fault));
    }
    if (frame.kind === FRAME_KIND.CLOSE_ACK) {
      if (state.pending.length !== 0 || state.reservations.length !== 0) {
        return deps.finish(deps.fault("early-close-ack"));
      }
      return deps.finish(deps.close());
    }
    return deps.finish(deps.fault("inbound-kind"));
  }
  return Object.freeze({ admit, process });
}
