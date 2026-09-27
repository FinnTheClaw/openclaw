import type { SessionFault } from "./session-fault.js";
import {
  MAX_TOMBSTONES,
  TERMINAL_GRACE_NS,
  hasSequence,
  isRequestId,
  touch,
  type ResultProof,
  type SessionAction,
  type SessionState,
  type TerminalCause,
} from "./session-state.js";

export type TerminalReducer = (params: {
  requestId: string;
  cause: Exclude<TerminalCause, "result">;
  nowNs: bigint;
}) => readonly SessionAction[];

export function processResultProof(
  proof: ResultProof | undefined,
  fault: (reason: SessionFault) => readonly SessionAction[],
): readonly SessionAction[] {
  if (proof?.kind === "winner-result") {
    return Object.freeze([]);
  }
  if (proof?.kind === "tombstone-loser") {
    return Object.freeze([{ type: "DISCARD_LOSING_TERMINAL" }]);
  }
  return fault("missing-result-proof");
}

export function createTerminalEngine(deps: {
  state(): SessionState;
  installCancel(requestId: string, deadlineNs: bigint, nowNs: bigint): readonly SessionAction[];
  installDrain(nowNs: bigint): readonly SessionAction[];
  fault(reason: SessionFault): readonly SessionAction[];
}) {
  return function terminal(params: {
    requestId: string;
    cause: Exclude<TerminalCause, "result">;
    nowNs: bigint;
  }): readonly SessionAction[] {
    const state = deps.state();
    if (!isRequestId(params.requestId)) {
      return deps.fault("request-id");
    }
    const pending = state.pending.find((item) => item.requestId === params.requestId);
    if (pending) {
      if (params.cause === "timeout" && params.nowNs < pending.deadlineNs) {
        return deps.fault("terminal-deadline");
      }
      if (state.tombstones.length >= MAX_TOMBSTONES) {
        return deps.fault("tombstone-cap");
      }
      state.pending = state.pending.filter((item) => item !== pending);
      state.tombstones.push({
        requestId: params.requestId,
        deadlineNs: pending.deadlineNs,
        cause: params.cause,
        expiresNs: params.nowNs + TERMINAL_GRACE_NS,
        loserSeen: false,
      });
      touch(state);
      if (state.phase === "ACTIVE" && !hasSequence(state, 1, true)) {
        state.phase = "DRAIN_PENDING";
        touch(state);
        return deps.installDrain(params.nowNs);
      }
      return deps.installCancel(params.requestId, pending.deadlineNs, params.nowNs);
    }
    const tombstone = state.tombstones.find((item) => item.requestId === params.requestId);
    if (
      !tombstone ||
      tombstone.loserSeen ||
      tombstone.cause === params.cause ||
      tombstone.expiresNs <= params.nowNs
    ) {
      return deps.fault("terminal-replay-or-nonpending");
    }
    state.tombstones = state.tombstones.map((item) =>
      item === tombstone ? { ...item, loserSeen: true } : item,
    );
    touch(state);
    return Object.freeze([{ type: "DISCARD_LOSING_TERMINAL" }]);
  };
}
