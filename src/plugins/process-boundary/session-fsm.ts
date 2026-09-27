import {
  FRAME_BODY_CAP,
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  MAX_DEADLINE_AHEAD_NS,
  createGenerationCodec,
} from "./frame-codec.js";
import type { SessionCapabilityBindings } from "./session-capabilities.js";
import { reconcileSessionExpiry } from "./session-expiry.js";
import { bindSessionFacades } from "./session-facades.js";
import type { SessionFault } from "./session-fault.js";
import { createInboundEngine } from "./session-inbound.js";
import { createOutboundEngine } from "./session-outbound.js";
import {
  MAX_TRACKED_REQUESTS,
  createState,
  hasSequence,
  isLivePhase,
  isRequestId,
  isTerminalPhase,
  queueFull,
  requestBusy,
  snapshot,
  touch,
  type Cleanup,
  type ControllerResult,
  type SessionAction,
  type SessionEvent,
  type SessionState,
} from "./session-state.js";
import { createTerminalEngine } from "./session-terminal.js";

export {
  DRAIN_GRACE_NS,
  MAX_CANCEL_SLOTS,
  MAX_PENDING,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_FRAMES,
  MAX_REGISTRATIONS,
  MAX_TRACKED_REQUESTS,
  RESERVED_QUEUE_BYTES,
  TERMINAL_GRACE_NS,
  type Cleanup,
  type ControllerResult,
  type SessionAction,
  type SessionPhase,
  type SessionSnapshot,
} from "./session-state.js";
export type {
  MonotonicClock,
  SessionCapabilityBindings,
  SessionIngressPort,
  SessionLifecyclePort,
  SessionObserver,
  SessionTransportPort,
  SessionWorkPort,
} from "./session-capabilities.js";
export type { SessionFault } from "./session-fault.js";

function freezeActions(actions: readonly SessionAction[]): readonly SessionAction[] {
  return Object.freeze(actions.map((action) => Object.freeze(action)));
}

/** @internal Native adapters will own the sole production call site in C07a.2.2/.3. */
export function installSessionGeneration(
  params: Readonly<{
    generation: bigint;
    bootEpoch: string;
    registrationLimit?: number;
  }>,
  bindings: SessionCapabilityBindings,
): void {
  const codec = createGenerationCodec({
    bootEpoch: Buffer.from(params.bootEpoch, "hex"),
    generation: params.generation,
  });
  const state: SessionState = createState({
    ...params,
    channelId: codec.channelId.toString("hex"),
  });
  const result = (actions: readonly SessionAction[] = []): ControllerResult =>
    Object.freeze({ snapshot: snapshot(state), actions: freezeActions(actions) });

  function fenceAndStop(
    phase: "STOPPING" | "RECOVERY_REQUIRED",
    reason: SessionFault | undefined,
    action: SessionAction,
  ): readonly SessionAction[] {
    if (isTerminalPhase(state.phase)) {
      return Object.freeze([]);
    }
    codec.fence();
    state.authorityVersion += 1n;
    state.phase = phase;
    state.pending = [];
    state.tombstones = [];
    state.reservations = [];
    state.drainDeadlineNs = undefined;
    if (reason === undefined) {
      delete state.fault;
    } else {
      state.fault = reason;
    }
    touch(state);
    return Object.freeze([action]);
  }
  const fault = (reason: SessionFault) =>
    fenceAndStop("STOPPING", reason, { type: "CLOSE_AND_STOP" });
  const recover = (reason: SessionFault) =>
    fenceAndStop("RECOVERY_REQUIRED", reason, { type: "CLOSE_AND_STOP" });
  function observeNow(nowNs: bigint): readonly SessionAction[] | undefined {
    if (isTerminalPhase(state.phase)) {
      return Object.freeze([]);
    }
    if (nowNs < 0n || nowNs < state.lastNowNs) {
      return fault("monotonic-time");
    }
    state.lastNowNs = nowNs;
    touch(state);
    return undefined;
  }
  const reconcileExpiry = (nowNs: bigint) => reconcileSessionExpiry(state, nowNs, fault);
  const advanceNow = (nowNs: bigint) => observeNow(nowNs) ?? reconcileExpiry(nowNs);

  const outbound = createOutboundEngine({
    state: () => state,
    codec,
    observeNow,
    reconcileExpiry,
    fault,
    localTimeoutAfterCommit: (requestId, nowNs) => terminal({ requestId, cause: "timeout", nowNs }),
  });
  const terminal = createTerminalEngine({
    state: () => state,
    installCancel: (requestId, deadlineNs, nowNs) =>
      outbound.install(
        { kind: FRAME_KIND.CANCEL, requestId: Buffer.from(requestId, "hex"), deadlineNs },
        nowNs,
      ),
    installDrain: (nowNs) => outbound.install({ kind: FRAME_KIND.DRAIN }, nowNs),
    fault,
  });

  function dispatch(event: SessionEvent): ControllerResult {
    if (isTerminalPhase(state.phase)) {
      return result();
    }
    if ("nowNs" in event) {
      const timeFault = advanceNow(event.nowNs);
      if (timeFault) {
        return result(timeFault);
      }
    }
    if (event.type === "LOCAL_CLEANUP_UNCERTAIN") {
      return result(recover(event.reason));
    }
    if (event.type === "LOCAL_CLEANUP_PROGRESS" && state.phase === "STOPPING") {
      state.cleanup = Object.freeze(
        Object.fromEntries(
          Object.entries(state.cleanup).map(([name, complete]) => [
            name,
            complete || event.completed[name as keyof Cleanup] === true,
          ]),
        ) as Cleanup,
      );
      touch(state);
      return result();
    }
    if (event.type === "LOCAL_EXIT_PROOF" && state.phase === "STOPPING") {
      const complete =
        Object.values(state.cleanup).every(Boolean) && state.reservations.length === 0;
      if (!complete) {
        return result(recover("incomplete-exit-proof"));
      }
      codec.fence();
      state.phase = "EXIT_VERIFIED";
      touch(state);
      return result();
    }
    if (state.phase === "STOPPING") {
      return result();
    }
    if (event.type === "LOCAL_FAULT" && isLivePhase(state.phase)) {
      return result(fault(event.reason));
    }
    if (event.type === "LOCAL_CONNECTION" && state.phase === "NEW") {
      state.phase = "ATTESTING";
      touch(state);
      return result();
    }
    if (event.type === "LOCAL_ATTESTED" && state.phase === "ATTESTING") {
      state.phase = "KEYED";
      touch(state);
      return result();
    }
    if (event.type === "LOCAL_INVOKE" && state.phase === "ACTIVE") {
      const planned = state.reservations.filter(
        (item) => item.mode === "outbound" && item.metadata.kind === FRAME_KIND.INVOKE,
      ).length;
      if (
        !isRequestId(event.requestId) ||
        event.deadlineNs <= event.nowNs ||
        event.deadlineNs - event.nowNs > MAX_DEADLINE_AHEAD_NS ||
        event.body.byteLength > FRAME_BODY_CAP ||
        requestBusy(state, event.requestId)
      ) {
        return result(fault("invoke-admission"));
      }
      if (state.pending.length + state.tombstones.length + planned >= MAX_TRACKED_REQUESTS) {
        return result([{ type: "REJECT_LOCAL_INVOKE", reason: "capacity" }]);
      }
      if (queueFull(state, "ordinary", FRAME_HEADER_BYTES + event.body.byteLength)) {
        return result([{ type: "REJECT_LOCAL_INVOKE", reason: "backpressure" }]);
      }
      if (!hasSequence(state, 1, true)) {
        state.phase = "DRAIN_PENDING";
        touch(state);
        const actions = outbound.install({ kind: FRAME_KIND.DRAIN }, event.nowNs);
        return result([{ type: "REJECT_LOCAL_INVOKE", reason: "sequence-drain" }, ...actions]);
      }
      return result(
        outbound.install(
          {
            kind: FRAME_KIND.INVOKE,
            requestId: Buffer.from(event.requestId, "hex"),
            deadlineNs: event.deadlineNs,
            body: Buffer.from(event.body),
          },
          event.nowNs,
        ),
      );
    }
    if (
      event.type === "LOCAL_INVOKE" &&
      (state.phase === "DRAIN_PENDING" || state.phase === "DRAINING")
    ) {
      return result([{ type: "REJECT_LOCAL_INVOKE", reason: "draining" }]);
    }
    if (
      event.type === "LOCAL_TERMINAL" &&
      (state.phase === "ACTIVE" || state.phase === "DRAIN_PENDING" || state.phase === "DRAINING")
    ) {
      return result(terminal(event));
    }
    if (event.type === "LOCAL_START_DRAIN" && state.phase === "ACTIVE") {
      state.phase = "DRAIN_PENDING";
      touch(state);
      return result(outbound.install({ kind: FRAME_KIND.DRAIN }, event.nowNs));
    }
    if (event.type === "LOCAL_DRAIN_GRACE_EXPIRED" && state.phase === "DRAINING") {
      if (state.drainDeadlineNs === undefined) {
        return result(fault("missing-drain-deadline"));
      }
      if (event.nowNs < state.drainDeadlineNs) {
        return result();
      }
      return result(
        fenceAndStop("STOPPING", "drain-grace-expired", {
          type: "REJECT_PENDING_AND_FORCE_STOP",
        }),
      );
    }
    return result(fault("invalid-transition"));
  }

  const inbound = createInboundEngine({
    state: () => state,
    decode: codec.decodeInbound,
    advanceNow,
    fault,
    recover,
    close: () => fenceAndStop("STOPPING", undefined, { type: "CLOSE_AND_STOP" }),
    finish: result,
    install: (kind, nowNs) => outbound.install({ kind }, nowNs),
  });

  bindSessionFacades({
    bindings,
    state: () => state,
    codec,
    result,
    fault,
    dispatch,
    inbound,
    outbound,
  });
}
