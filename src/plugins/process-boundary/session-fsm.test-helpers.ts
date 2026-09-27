import { expect } from "vitest";
import { FRAME_KIND, type PreparedFrame } from "./frame-codec.js";
import {
  MAX_REGISTRATIONS,
  type Cleanup,
  type ControllerResult,
  type SessionAction,
} from "./session-fsm.js";
import {
  createTestSession,
  inboundPacket,
  type SessionController,
} from "./session-test-harness.js";

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
} from "./session-fsm.js";
export { FRAME_KIND, UINT64_MAX } from "./frame-codec.js";
export {
  epochHex,
  inboundPacket,
  peerContext,
  testFacets,
  type SessionController,
} from "./session-test-harness.js";

export const cleanup: Cleanup = {
  ingress: true,
  handles: true,
  pending: true,
  channel: true,
  service: true,
  processIdentity: true,
  unitState: true,
  cgroup: true,
};

export function requestHex(index: number): string {
  return index.toString(16).padStart(32, "0");
}
export function action<T extends SessionAction["type"]>(
  result: ControllerResult,
  type: T,
): Extract<SessionAction, { type: T }> {
  const found = result.actions.find((item) => item.type === type);
  if (!found) {
    throw new Error(`missing ${type}`);
  }
  return found as Extract<SessionAction, { type: T }>;
}
export function admit(
  controller: SessionController,
  id: string,
  params: Omit<Parameters<typeof inboundPacket>[0], "controller">,
  nowNs = 1n,
): ControllerResult {
  return controller.admitInbound(inboundPacket({ controller, ...params, nowNs }), id, nowNs);
}
export function deliver(
  controller: SessionController,
  id: string,
  params: Omit<Parameters<typeof inboundPacket>[0], "controller">,
  options: { inventoryMatches?: boolean; nowNs?: bigint } = {},
): ControllerResult {
  const nowNs = options.nowNs ?? 1n;
  const admitted = admit(controller, id, params, nowNs);
  return admitted.snapshot.phase === "STOPPING" ? admitted : controller.processInbound(id, options);
}
export function sendFrame(result: ControllerResult): PreparedFrame {
  return action(result, "SEND_PREPARED").frame;
}
export function completeSend(
  controller: SessionController,
  outbound: ControllerResult,
  nowNs = 1n,
): ControllerResult {
  const frame = sendFrame(outbound);
  const taken = controller.transport.takeForSend(frame, nowNs);
  expect(taken.packet).toBeDefined();
  expect(taken.result.actions).toEqual([]);
  return controller.transport.commitSent(frame, nowNs);
}
export function keyed(): SessionController {
  const controller = createTestSession();
  controller.dispatch({ type: "LOCAL_CONNECTION" });
  controller.dispatch({ type: "LOCAL_ATTESTED" });
  return controller;
}
export function loading(limit = MAX_REGISTRATIONS, generation = 1n): SessionController {
  const controller = createTestSession(limit, generation);
  controller.dispatch({ type: "LOCAL_CONNECTION" });
  controller.dispatch({ type: "LOCAL_ATTESTED" });
  completeSend(controller, deliver(controller, "ready", { kind: FRAME_KIND.SESSION_READY }));
  return controller;
}
export function active(
  limit = MAX_REGISTRATIONS,
  registrations = 0,
  generation = 1n,
): SessionController {
  const controller = loading(limit, generation);
  for (let index = 0; index < registrations; index += 1) {
    deliver(controller, `register-${index}`, { kind: FRAME_KIND.REGISTER });
  }
  completeSend(
    controller,
    deliver(controller, "done", { kind: FRAME_KIND.REGISTER_DONE }, { inventoryMatches: true }),
  );
  return controller;
}
export function requestInvoke(
  controller: SessionController,
  index: number,
  nowNs = 2n,
  deadlineNs = 1_000n,
  body: Uint8Array = Buffer.from([index & 0xff]),
): ControllerResult {
  return controller.dispatch({
    type: "LOCAL_INVOKE",
    requestId: requestHex(index),
    deadlineNs,
    body,
    nowNs,
  });
}
export function invoke(
  controller: SessionController,
  index: number,
  nowNs = 2n,
  deadlineNs = 1_000n,
): ControllerResult {
  return completeSend(controller, requestInvoke(controller, index, nowNs, deadlineNs), nowNs);
}
export function startDrain(controller: SessionController, nowNs: bigint): ControllerResult {
  return completeSend(controller, controller.dispatch({ type: "LOCAL_START_DRAIN", nowNs }), nowNs);
}
