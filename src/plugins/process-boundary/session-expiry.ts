import { FRAME_KIND } from "./frame-codec.js";
import type { SessionFault } from "./session-fault.js";
import { isTerminalPhase, touch, type SessionAction, type SessionState } from "./session-state.js";

export function reconcileSessionExpiry(
  state: SessionState,
  nowNs: bigint,
  fault: (reason: SessionFault) => readonly SessionAction[],
): readonly SessionAction[] | undefined {
  if (isTerminalPhase(state.phase)) {
    return Object.freeze([]);
  }
  const expiredOutbound = state.reservations.some(
    (item) =>
      item.mode === "outbound" &&
      ((item.metadata.kind === FRAME_KIND.INVOKE && item.metadata.deadlineNs! <= nowNs) ||
        (item.metadata.kind === FRAME_KIND.CANCEL &&
          state.tombstones.some(
            (tombstone) =>
              tombstone.requestId === item.metadata.requestId &&
              tombstone.deadlineNs === item.metadata.deadlineNs &&
              tombstone.expiresNs <= nowNs,
          ))),
  );
  if (expiredOutbound) {
    return fault("expired-outbound-obligation");
  }
  const retained = state.tombstones.filter((item) => item.expiresNs > nowNs);
  if (retained.length !== state.tombstones.length) {
    state.tombstones = retained;
    touch(state);
  }
  return undefined;
}
