import type { PreparedFrame } from "./frame-codec.js";
import type {
  SessionCapabilityBindings,
  SessionIngressPort,
  SessionLifecyclePort,
  SessionObserver,
  SessionTransportPort,
  SessionWorkPort,
} from "./session-capabilities.js";
import type { SessionFault } from "./session-fault.js";
import {
  captureAdmit,
  captureCleanup,
  captureClock,
  captureInvoke,
  captureProcess,
  captureTerminal,
  type InputCapture,
} from "./session-input-capture.js";
import {
  createSessionMutationBoundary,
  type MutationAttempt,
} from "./session-mutation-boundary.js";
import {
  isLivePhase,
  isTerminalPhase,
  type ControllerResult,
  type SessionAction,
  type SessionEvent,
  type SessionState,
} from "./session-state.js";

type Inbound = Readonly<{
  admit(packet: Uint8Array, id: string, nowNs: bigint): ControllerResult;
  process(
    id: string,
    options: Readonly<{ nowNs: bigint; inventoryMatches?: boolean }>,
  ): ControllerResult;
}>;
type Outbound = Readonly<{
  takeForSend(
    frame: PreparedFrame,
    nowNs: bigint,
  ): Readonly<{ packet?: Buffer; actions: readonly SessionAction[] }>;
  commitSent(frame: PreparedFrame, nowNs: bigint): readonly SessionAction[];
}>;
type FacadeDeps = Readonly<{
  bindings: SessionCapabilityBindings;
  state(): SessionState;
  codec: Readonly<{ deliverKeyInstall(deliver: (packet: Buffer) => boolean): void }>;
  result(actions?: readonly SessionAction[]): ControllerResult;
  fault(reason: SessionFault): readonly SessionAction[];
  dispatch(event: SessionEvent): ControllerResult;
  inbound: Inbound;
  outbound: Outbound;
}>;

export function bindSessionFacades(deps: FacadeDeps): void {
  const state = deps.state;
  let deferredActions: readonly SessionAction[] = Object.freeze([]);
  const boundary = createSessionMutationBoundary(() => {
    deferredActions = deps.fault("controller-reentry");
  });
  const current = (attempt: MutationAttempt) => boundary.current(attempt);
  const empty = () => deps.result();
  const takeDeferredActions = () => {
    const actions = deferredActions;
    deferredActions = Object.freeze([]);
    return actions;
  };
  const aborted = () => deps.result(takeDeferredActions());

  function guarded<T>(emptyValue: () => T, run: (attempt: MutationAttempt) => T): T {
    if (isTerminalPhase(state().phase)) {
      return emptyValue();
    }
    const attempt = boundary.enter();
    if (!attempt) {
      return emptyValue();
    }
    try {
      return run(attempt);
    } finally {
      boundary.leave(attempt);
    }
  }

  const stillCurrent = (attempt: MutationAttempt) => () => current(attempt);
  const readNow = (attempt: MutationAttempt) =>
    captureClock(deps.bindings.clock.nowNs, stillCurrent(attempt));

  function clocked(
    attempt: MutationAttempt,
    run: (nowNs: bigint) => ControllerResult,
  ): ControllerResult {
    const now = readNow(attempt);
    if (now.kind === "aborted") {
      return aborted();
    }
    if (isTerminalPhase(state().phase)) {
      return empty();
    }
    if (now.kind === "fault") {
      return deps.result(deps.fault(now.reason));
    }
    return run(now.value);
  }

  function capturedOrFault<T extends object>(value: InputCapture<T>): T | ControllerResult {
    if (value.kind === "ok") {
      return value.value;
    }
    return value.kind === "fault" ? deps.result(deps.fault(value.reason)) : aborted();
  }

  const observer: SessionObserver = Object.freeze({ snapshot: () => deps.result().snapshot });
  const work: SessionWorkPort = Object.freeze({
    invoke: (input) =>
      guarded(empty, (attempt) => {
        const value = capturedOrFault(captureInvoke(input, stillCurrent(attempt)));
        if ("snapshot" in value) {
          return value;
        }
        return clocked(attempt, (nowNs) =>
          deps.dispatch({ type: "LOCAL_INVOKE", ...value, nowNs }),
        );
      }),
    terminal: (input) =>
      guarded(empty, (attempt) => {
        const value = capturedOrFault(captureTerminal(input, stillCurrent(attempt)));
        if ("snapshot" in value) {
          return value;
        }
        return clocked(attempt, (nowNs) =>
          deps.dispatch({ type: "LOCAL_TERMINAL", ...value, nowNs }),
        );
      }),
    startDrain: () =>
      guarded(empty, (attempt) =>
        clocked(attempt, (nowNs) => deps.dispatch({ type: "LOCAL_START_DRAIN", nowNs })),
      ),
  });
  const ingress: SessionIngressPort = Object.freeze({
    admit: (packet, id) =>
      guarded(empty, (attempt) => {
        const value = capturedOrFault(captureAdmit(packet, id, stillCurrent(attempt)));
        if ("snapshot" in value) {
          return value;
        }
        return clocked(attempt, (nowNs) => deps.inbound.admit(value.packet, value.id, nowNs));
      }),
    process: (id, options) =>
      guarded(empty, (attempt) => {
        const value = capturedOrFault(captureProcess(id, options, stillCurrent(attempt)));
        if ("snapshot" in value) {
          return value;
        }
        return clocked(attempt, (nowNs) =>
          deps.inbound.process(value.id, {
            nowNs,
            ...(value.inventoryMatches === undefined
              ? {}
              : { inventoryMatches: value.inventoryMatches }),
          }),
        );
      }),
  });
  const transport: SessionTransportPort = Object.freeze({
    takeForSend: (frame) =>
      guarded(
        () => Object.freeze({ result: empty() }),
        (attempt) => {
          const now = readNow(attempt);
          if (now.kind === "aborted") {
            return Object.freeze({ result: aborted() });
          }
          if (isTerminalPhase(state().phase)) {
            return Object.freeze({ result: empty() });
          }
          if (now.kind === "fault") {
            return Object.freeze({ result: deps.result(deps.fault(now.reason)) });
          }
          const taken = deps.outbound.takeForSend(frame, now.value);
          return Object.freeze({
            ...(taken.packet ? { packet: taken.packet } : {}),
            result: deps.result(taken.actions),
          });
        },
      ),
    commitSent: (frame) =>
      guarded(empty, (attempt) =>
        clocked(attempt, (nowNs) => deps.result(deps.outbound.commitSent(frame, nowNs))),
      ),
  });
  const lifecycle: SessionLifecyclePort = Object.freeze({
    connected: () => guarded(empty, () => deps.dispatch({ type: "LOCAL_CONNECTION" })),
    attested: () =>
      guarded(empty, (attempt) => {
        if (state().phase !== "ATTESTING") {
          return deps.dispatch({ type: "LOCAL_ATTESTED" });
        }
        try {
          deps.codec.deliverKeyInstall(
            (packet) => deps.bindings.deliverKeyInstall(packet) === true && current(attempt),
          );
        } catch {
          takeDeferredActions();
          return deps.result(deps.fault("key-install"));
        }
        return current(attempt) ? deps.dispatch({ type: "LOCAL_ATTESTED" }) : empty();
      }),
    fail: () =>
      guarded(empty, () => deps.dispatch({ type: "LOCAL_FAULT", reason: "lifecycle-fault" })),
    cleanupProgress: (input) =>
      guarded(empty, (attempt) => {
        const value = capturedOrFault(captureCleanup(input, stillCurrent(attempt)));
        return "snapshot" in value
          ? value
          : deps.dispatch({ type: "LOCAL_CLEANUP_PROGRESS", completed: value });
      }),
    exitProof: () => guarded(empty, () => deps.dispatch({ type: "LOCAL_EXIT_PROOF" })),
    cleanupUncertain: () =>
      guarded(empty, () =>
        deps.dispatch({ type: "LOCAL_CLEANUP_UNCERTAIN", reason: "cleanup-uncertain" }),
      ),
    drainGraceExpired: () =>
      guarded(empty, (attempt) =>
        clocked(attempt, (nowNs) => deps.dispatch({ type: "LOCAL_DRAIN_GRACE_EXPIRED", nowNs })),
      ),
  });

  const installation = boundary.enter();
  if (!installation) {
    throw new Error("controller-reentry");
  }
  try {
    deps.bindings.bindObserver(observer);
    if (!current(installation)) {
      throw new Error("controller-reentry");
    }
    deps.bindings.bindWork(work);
    if (!current(installation)) {
      throw new Error("controller-reentry");
    }
    deps.bindings.bindIngress(ingress);
    if (!current(installation)) {
      throw new Error("controller-reentry");
    }
    deps.bindings.bindTransport(transport);
    if (!current(installation)) {
      throw new Error("controller-reentry");
    }
    deps.bindings.bindLifecycle(lifecycle);
    if (!current(installation)) {
      throw new Error("controller-reentry");
    }
  } catch {
    if (!current(installation)) {
      takeDeferredActions();
      throw new Error("controller-reentry");
    }
    if (isLivePhase(state().phase)) {
      deps.fault("capability-binding");
    }
    throw new Error("capability-binding");
  } finally {
    boundary.leave(installation);
  }
}
