import { describe, expect, it } from "vitest";
import {
  FRAME_KIND,
  active,
  admit,
  completeSend,
  invoke,
  loading,
  requestHex,
  requestInvoke,
  sendFrame,
  startDrain,
} from "./session-fsm.test-helpers.js";

describe("C07 projected inbound authority", () => {
  it("projects queued registration count before processing", () => {
    const controller = loading(2);
    expect(
      admit(controller, "register-1", { kind: FRAME_KIND.REGISTER }).snapshot.inboundQueued,
    ).toBe(1);
    expect(
      admit(controller, "register-2", { kind: FRAME_KIND.REGISTER }).snapshot.inboundQueued,
    ).toBe(2);
    const overflow = admit(controller, "register-3", { kind: FRAME_KIND.REGISTER });
    expect(overflow.snapshot).toMatchObject({ phase: "STOPPING", fault: "registration-limit" });
    expect(overflow.snapshot.outboundQueued).toBe(0);
  });

  it.each([FRAME_KIND.REGISTER, FRAME_KIND.REGISTER_DONE])(
    "rejects kind 0x%s behind an authenticated REGISTER_DONE barrier",
    (kind) => {
      const controller = loading();
      expect(
        admit(controller, "done", { kind: FRAME_KIND.REGISTER_DONE }).snapshot.inboundQueued,
      ).toBe(1);
      const invalid = admit(controller, "post-done", { kind });
      expect(invalid.snapshot).toMatchObject({
        phase: "STOPPING",
        fault: "authenticated-frame-admission",
        outboundQueued: 0,
      });
    },
  );

  it("rejects CLOSE_ACK at admission while pending work exists", () => {
    const controller = active();
    invoke(controller, 1);
    startDrain(controller, 10n);
    const early = admit(controller, "early-ack", { kind: FRAME_KIND.CLOSE_ACK }, 11n);
    expect(early.snapshot).toMatchObject({
      phase: "STOPPING",
      fault: "early-close-ack",
      pendingCount: 0,
    });
    expect(early.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
  });

  it("admits CLOSE_ACK behind an already-admitted winning RESULT", () => {
    const controller = active();
    invoke(controller, 2);
    startDrain(controller, 10n);
    const winner = admit(
      controller,
      "winner",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(2), deadlineNs: 1_000n },
      11n,
    );
    expect(winner.snapshot).toMatchObject({ pendingCount: 0, inboundQueued: 1 });
    const ack = admit(controller, "ack", { kind: FRAME_KIND.CLOSE_ACK }, 12n);
    expect(ack.snapshot).toMatchObject({ phase: "DRAINING", inboundQueued: 2 });
    expect(controller.processInbound("winner", { nowNs: 12n }).actions).toEqual([]);
    const closed = controller.processInbound("ack", { nowNs: 12n });
    expect(closed.snapshot.phase).toBe("STOPPING");
    expect(closed.snapshot).not.toHaveProperty("fault");
    expect(closed.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
  });

  it.each([false, true])("rejects CLOSE_ACK with a %s consumed CANCEL obligation", (consumed) => {
    const controller = active();
    invoke(controller, 3);
    startDrain(controller, 10n);
    const cancel = controller.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(3),
      cause: "cancel",
      nowNs: 11n,
    });
    let packet: Buffer | undefined;
    if (consumed) {
      const taken = controller.transport.takeForSend(sendFrame(cancel), 11n);
      packet = taken.packet;
      expect(packet).toBeDefined();
    }
    const early = admit(controller, "early-ack", { kind: FRAME_KIND.CLOSE_ACK }, 12n);
    expect(early.snapshot).toMatchObject({ phase: "STOPPING", fault: "early-close-ack" });
    if (packet) {
      expect(packet).toEqual(Buffer.alloc(packet.length));
    }
  });

  it("admits CLOSE_ACK after the exact CANCEL obligation commits", () => {
    const controller = active();
    invoke(controller, 4);
    startDrain(controller, 10n);
    const cancel = controller.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(4),
      cause: "cancel",
      nowNs: 11n,
    });
    completeSend(controller, cancel, 11n);
    expect(admit(controller, "ack", { kind: FRAME_KIND.CLOSE_ACK }, 12n).snapshot.phase).toBe(
      "DRAINING",
    );
    const closed = controller.processInbound("ack", { nowNs: 12n }).snapshot;
    expect(closed.phase).toBe("STOPPING");
    expect(closed).not.toHaveProperty("fault");
  });

  it("fences FATAL immediately and zeroizes an already-consumed outbound alias", () => {
    const controller = active();
    const invokeResult = requestInvoke(controller, 5, 2n, 1_000n);
    const frame = sendFrame(invokeResult);
    const packet = controller.transport.takeForSend(frame, 2n).packet!;
    expect(packet.some((byte) => byte !== 0)).toBe(true);
    const fatal = admit(controller, "fatal", { kind: FRAME_KIND.FATAL }, 3n);
    expect(fatal.snapshot).toMatchObject({
      phase: "STOPPING",
      fault: "peer-fatal",
      outboundQueued: 0,
      pendingCount: 0,
    });
    expect(packet).toEqual(Buffer.alloc(packet.length));
    expect(controller.transport.commitSent(frame, 3n).snapshot.pendingCount).toBe(0);
  });
});
