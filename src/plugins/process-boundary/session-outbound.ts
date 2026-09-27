import {
  FRAME_KIND,
  UINT64_MAX,
  type OutboundSpec,
  type PreparedFrame,
  type PreparedMetadata,
} from "./frame-codec.js";
import type { SessionFault } from "./session-fault.js";
import {
  DRAIN_GRACE_NS,
  MAX_TRACKED_REQUESTS,
  hasSequence,
  isRequestId,
  laneFor,
  queueFull,
  requestBusy,
  specBytes,
  touch,
  type SessionAction,
  type SessionState,
} from "./session-state.js";

type Codec = Readonly<{
  prepare(
    spec: OutboundSpec,
    sequence: bigint,
    nowNs: bigint,
    revision: bigint,
    controllerVersion: bigint,
  ): Readonly<{
    token: PreparedFrame;
    metadata: PreparedMetadata;
  }>;
  take(
    token: unknown,
    fence: bigint,
    authorize: (metadata: PreparedMetadata) => boolean,
  ): Buffer | undefined;
  commit(token: unknown, fence: bigint): boolean;
  currentFence(): bigint;
}>;

export function createOutboundEngine(deps: {
  state(): SessionState;
  codec: Codec;
  observeNow(nowNs: bigint): readonly SessionAction[] | undefined;
  reconcileExpiry(nowNs: bigint): readonly SessionAction[] | undefined;
  fault(reason: SessionFault): readonly SessionAction[];
  localTimeoutAfterCommit(requestId: string, nowNs: bigint): readonly SessionAction[];
}) {
  function install(spec: OutboundSpec, nowNs: bigint): readonly SessionAction[] {
    const state = deps.state();
    const lane = laneFor(spec.kind);
    const bytes = specBytes(spec);
    if (!hasSequence(state) || queueFull(state, lane, bytes)) {
      return deps.fault(!hasSequence(state) ? "outbound-sequence-cap" : "outbound-obligation-cap");
    }
    const sequence = state.nextSequence["supervisor-to-worker"]!;
    const installRevision = state.revision + 1n;
    let prepared;
    try {
      prepared = deps.codec.prepare(spec, sequence, nowNs, installRevision, state.authorityVersion);
    } catch {
      return deps.fault("outbound-prepare");
    }
    state.nextSequence["supervisor-to-worker"] =
      sequence === UINT64_MAX - 1n ? null : sequence + 1n;
    state.reservations.push({
      mode: "outbound",
      lane,
      bytes,
      token: prepared.token,
      metadata: prepared.metadata,
    });
    touch(state);
    return Object.freeze([{ type: "SEND_PREPARED", frame: prepared.token }]);
  }

  function bindingLive(metadata: PreparedMetadata, nowNs: bigint): boolean {
    const state = deps.state();
    if (metadata.kind === FRAME_KIND.INVOKE) {
      return metadata.deadlineNs! > nowNs;
    }
    if (metadata.kind !== FRAME_KIND.CANCEL) {
      return true;
    }
    const tombstone = state.tombstones.find((item) => item.requestId === metadata.requestId);
    return Boolean(
      tombstone && tombstone.deadlineNs === metadata.deadlineNs && tombstone.expiresNs > nowNs,
    );
  }

  function takeForSend(frame: PreparedFrame, nowNs: bigint) {
    const timeFault = deps.observeNow(nowNs) ?? deps.reconcileExpiry(nowNs);
    if (timeFault) {
      return Object.freeze({ packet: undefined, actions: timeFault });
    }
    const state = deps.state();
    const first = state.reservations.find((item) => item.mode === "outbound");
    const fence = deps.codec.currentFence();
    const packet = deps.codec.take(frame, fence, (metadata) =>
      Boolean(
        first &&
        first.mode === "outbound" &&
        first.token === frame &&
        first.metadata === metadata &&
        metadata.installRevision === first.metadata.installRevision &&
        metadata.installRevision <= state.revision &&
        metadata.controllerVersion === state.authorityVersion &&
        metadata.generation === state.generation &&
        bindingLive(metadata, nowNs) &&
        deps.codec.currentFence() === fence,
      ),
    );
    if (!packet) {
      return Object.freeze({ packet: undefined, actions: deps.fault("outbound-take-binding") });
    }
    return Object.freeze({ packet, actions: Object.freeze([]) });
  }

  function commitSent(frame: PreparedFrame, nowNs: bigint): readonly SessionAction[] {
    const timeFault = deps.observeNow(nowNs);
    if (timeFault) {
      return timeFault;
    }
    const state = deps.state();
    const first = state.reservations.find((item) => item.mode === "outbound");
    const fence = deps.codec.currentFence();
    if (
      !first ||
      first.mode !== "outbound" ||
      first.token !== frame ||
      !deps.codec.commit(frame, fence)
    ) {
      return deps.fault("outbound-commit-fifo-or-replay");
    }
    state.reservations = state.reservations.filter((item) => item !== first);
    const metadata = first.metadata;
    touch(state);
    const finish = (actions: readonly SessionAction[] = Object.freeze([])) =>
      deps.reconcileExpiry(nowNs) ?? actions;
    if (metadata.kind === FRAME_KIND.LOAD_PACKAGE) {
      if (state.phase !== "LOAD_PENDING") {
        return deps.fault("load-commit-phase");
      }
      state.phase = "LOADING";
    } else if (metadata.kind === FRAME_KIND.REGISTER_ACCEPT) {
      if (state.phase !== "ACCEPT_PENDING") {
        return deps.fault("accept-commit-phase");
      }
      state.phase = "ACTIVE";
    } else if (metadata.kind === FRAME_KIND.INVOKE) {
      const requestId = metadata.requestId ?? "";
      if (
        !isRequestId(requestId) ||
        metadata.deadlineNs === undefined ||
        state.pending.length + state.tombstones.length >= MAX_TRACKED_REQUESTS ||
        requestBusy(state, requestId)
      ) {
        return deps.fault("invoke-commit");
      }
      state.pending.push({ requestId, deadlineNs: metadata.deadlineNs });
      touch(state);
      if (metadata.deadlineNs <= nowNs) {
        return finish(deps.localTimeoutAfterCommit(requestId, nowNs));
      }
    } else if (metadata.kind === FRAME_KIND.DRAIN) {
      if (state.phase !== "DRAIN_PENDING") {
        return deps.fault("drain-commit-phase");
      }
      state.phase = "DRAINING";
      state.drainDeadlineNs = nowNs + DRAIN_GRACE_NS;
      touch(state);
    }
    return finish();
  }

  return Object.freeze({ install, takeForSend, commitSent });
}
