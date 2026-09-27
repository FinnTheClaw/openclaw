import { describe, expect, it } from "vitest";
import { FRAME_BODY_CAP } from "./frame-codec.js";
import {
  FRAME_KIND,
  MAX_CANCEL_SLOTS,
  MAX_PENDING,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_FRAMES,
  MAX_REGISTRATIONS,
  MAX_TRACKED_REQUESTS,
  TERMINAL_GRACE_NS,
  action,
  active,
  admit,
  completeSend,
  deliver,
  invoke,
  loading,
  requestHex,
  requestInvoke,
} from "./session-fsm.test-helpers.js";

describe("C07 private session limits", () => {
  it.each([0, 1, MAX_REGISTRATIONS])("counts %i authenticated registrations", (count) => {
    expect(active(MAX_REGISTRATIONS, count).snapshot().registrations).toBe(count);
  });

  it("rejects registration count, byte, and inventory violations", () => {
    const count = loading();
    for (let index = 0; index < MAX_REGISTRATIONS; index += 1) {
      deliver(count, `r-${index}`, { kind: FRAME_KIND.REGISTER });
    }
    expect(deliver(count, "overflow", { kind: FRAME_KIND.REGISTER }).snapshot.fault).toBe(
      "registration-limit",
    );
    expect(
      deliver(
        loading(),
        "bad-done",
        { kind: FRAME_KIND.REGISTER_DONE },
        { inventoryMatches: false },
      ).snapshot.fault,
    ).toBe("registration-inventory");
    const bytes = loading();
    for (let index = 0; index < 16; index += 1) {
      deliver(bytes, `bulk-${index}`, { kind: FRAME_KIND.REGISTER, body: Buffer.alloc(262_144) });
    }
    expect(bytes.snapshot().registrationBytes).toBe(MAX_QUEUE_BYTES);
    expect(
      deliver(bytes, "bulk-over", { kind: FRAME_KIND.REGISTER, body: Buffer.from([1]) }).snapshot
        .fault,
    ).toBe("registration-limit");
  });

  it("enforces private inbound frame and byte reservations", () => {
    const frames = loading();
    for (let index = 0; index < MAX_QUEUE_FRAMES; index += 1) {
      admit(frames, `q-${index}`, { kind: FRAME_KIND.REGISTER });
    }
    expect(frames.snapshot().inboundQueued).toBe(MAX_QUEUE_FRAMES);
    expect(admit(frames, "q-over", { kind: FRAME_KIND.REGISTER }).snapshot.fault).toBe("queue-cap");
    const bytes = loading();
    for (let index = 0; index < 16; index += 1) {
      admit(bytes, `b-${index}`, { kind: FRAME_KIND.REGISTER, body: Buffer.alloc(262_016) });
    }
    expect(admit(bytes, "byte-over", { kind: FRAME_KIND.REGISTER }).snapshot.fault).toBe(
      "queue-cap",
    );
  });

  it("counts installed outbound packets against the shared ordinary cap", () => {
    const controller = active();
    invoke(controller, 1);
    for (let index = 2; index <= 4; index += 1) {
      requestInvoke(controller, index, 3n, 1_000n, Buffer.alloc(FRAME_BODY_CAP));
    }
    expect(controller.snapshot().outboundQueued).toBe(3);
    const overflow = admit(
      controller,
      "mixed-overflow",
      {
        kind: FRAME_KIND.RESULT,
        requestId: requestHex(1),
        deadlineNs: 1_000n,
        body: Buffer.alloc(FRAME_BODY_CAP),
      },
      3n,
    );
    expect(overflow.snapshot.fault).toBe("queue-cap");
  });

  it("backpressures 32 live tombstones and admits at exact expiry", () => {
    const controller = active();
    for (let index = 1; index <= MAX_TRACKED_REQUESTS; index += 1) {
      invoke(controller, index);
    }
    for (let index = 1; index <= MAX_TRACKED_REQUESTS; index += 1) {
      completeSend(
        controller,
        controller.dispatch({
          type: "LOCAL_TERMINAL",
          requestId: requestHex(index),
          cause: "cancel",
          nowNs: 3n,
        }),
        3n,
      );
    }
    expect(controller.snapshot().tombstoneCount).toBe(MAX_TRACKED_REQUESTS);
    for (let index = 1; index <= MAX_TRACKED_REQUESTS; index += 1) {
      admit(
        controller,
        `loser-${index}`,
        { kind: FRAME_KIND.RESULT, requestId: requestHex(index), deadlineNs: 1_000n },
        4n,
      );
    }
    expect(controller.snapshot().inboundQueued).toBe(MAX_TRACKED_REQUESTS);
    const rejected = requestInvoke(controller, 33, 4n);
    expect(action(rejected, "REJECT_LOCAL_INVOKE").reason).toBe("capacity");
    const expiresNs = 3n + TERMINAL_GRACE_NS;
    const accepted = requestInvoke(controller, 33, expiresNs, expiresNs + 100n);
    expect(accepted.snapshot.tombstoneCount).toBe(0);
    expect(accepted.snapshot.inboundQueued).toBe(MAX_TRACKED_REQUESTS);
    expect(action(accepted, "SEND_PREPARED").frame).toBeDefined();
  });

  it("reserves FATAL admission through 32 CANCEL packets and fences immediately", () => {
    const controller = active();
    for (let index = 1; index <= MAX_PENDING; index += 1) {
      invoke(controller, index);
    }
    for (let index = 1; index <= MAX_CANCEL_SLOTS; index += 1) {
      controller.dispatch({
        type: "LOCAL_TERMINAL",
        requestId: requestHex(index),
        cause: "cancel",
        nowNs: 3n,
      });
    }
    expect(controller.snapshot().outboundQueued).toBe(32);
    const fatal = admit(controller, "fatal", { kind: FRAME_KIND.FATAL }, 3n);
    expect(fatal.snapshot).toMatchObject({
      phase: "STOPPING",
      fault: "peer-fatal",
      inboundQueued: 0,
      outboundQueued: 0,
    });
    expect(fatal.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
  });
});
