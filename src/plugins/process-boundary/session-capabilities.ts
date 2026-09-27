import type { PreparedFrame } from "./frame-codec.js";
import type { Cleanup, ControllerResult, SessionSnapshot, TerminalCause } from "./session-state.js";

export type MonotonicClock = Readonly<{ nowNs(): bigint }>;

export type SessionObserver = Readonly<{
  snapshot(): SessionSnapshot;
}>;

export type SessionWorkPort = Readonly<{
  invoke(
    params: Readonly<{ requestId: string; deadlineNs: bigint; body: Uint8Array }>,
  ): ControllerResult;
  terminal(
    params: Readonly<{ requestId: string; cause: Exclude<TerminalCause, "result"> }>,
  ): ControllerResult;
  startDrain(): ControllerResult;
}>;

export type SessionIngressPort = Readonly<{
  admit(packet: Uint8Array, id: string): ControllerResult;
  process(id: string, options?: Readonly<{ inventoryMatches?: boolean }>): ControllerResult;
}>;

export type SessionTransportPort = Readonly<{
  takeForSend(frame: PreparedFrame): Readonly<{ packet?: Buffer; result: ControllerResult }>;
  commitSent(frame: PreparedFrame): ControllerResult;
}>;

export type SessionLifecyclePort = Readonly<{
  connected(): ControllerResult;
  attested(): ControllerResult;
  fail(): ControllerResult;
  cleanupProgress(completed: Partial<Cleanup>): ControllerResult;
  exitProof(): ControllerResult;
  cleanupUncertain(): ControllerResult;
  drainGraceExpired(): ControllerResult;
}>;

export type SessionCapabilityBindings = Readonly<{
  clock: MonotonicClock;
  deliverKeyInstall(packet: Buffer): boolean;
  bindObserver(port: SessionObserver): void;
  bindWork(port: SessionWorkPort): void;
  bindIngress(port: SessionIngressPort): void;
  bindTransport(port: SessionTransportPort): void;
  bindLifecycle(port: SessionLifecyclePort): void;
}>;
