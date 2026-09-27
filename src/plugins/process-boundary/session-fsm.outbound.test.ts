import { describe, expect, it } from "vitest";
import {
  FRAME_KIND,
  TERMINAL_GRACE_NS,
  active,
  admit,
  deliver,
  invoke,
  keyed,
  requestHex,
  requestInvoke,
  sendFrame,
} from "./session-fsm.test-helpers.js";

describe("C07 atomic instance-bound transport", () => {
  it("installs sequence/accounting state before exposing a send token", () => {
    const controller = active();
    const requested = requestInvoke(controller, 1, 2n, 1_000n, Buffer.from([7]));
    expect(requested.snapshot.pendingCount).toBe(0);
    expect(requested.snapshot.outboundQueued).toBe(1);
    expect(requested.actions).toHaveLength(1);
    const token = sendFrame(requested);
    expect(Object.keys(token)).toEqual([]);
    expect(controller.transport.takeForSend(token, 2n).packet?.readBigUInt64BE(56)).toBe(3n);
  });

  it("applies lifecycle and pending effects only after one matching send commit", () => {
    const controller = keyed();
    const ready = deliver(controller, "ready", { kind: FRAME_KIND.SESSION_READY });
    const load = sendFrame(ready);
    const taken = controller.transport.takeForSend(load, 1n);
    expect(taken.packet).toHaveLength(128);
    expect(controller.snapshot().phase).toBe("LOAD_PENDING");
    expect(controller.transport.commitSent(load, 1n).snapshot.phase).toBe("LOADING");

    const done = deliver(
      controller,
      "done",
      { kind: FRAME_KIND.REGISTER_DONE },
      { inventoryMatches: true },
    );
    const accept = sendFrame(done);
    expect(controller.transport.takeForSend(accept, 1n).packet).toHaveLength(128);
    expect(controller.snapshot().phase).toBe("ACCEPT_PENDING");
    expect(controller.transport.commitSent(accept, 1n).snapshot.phase).toBe("ACTIVE");
  });

  it("keeps consumed-but-uncommitted INVOKE free of dependent FSM effects", () => {
    const controller = active();
    const requested = requestInvoke(controller, 1, 2n, 1_000n);
    const frame = sendFrame(requested);
    const taken = controller.transport.takeForSend(frame, 2n);
    expect(taken.packet).toBeDefined();
    const packet = taken.packet!;
    expect(packet[6]).toBe(FRAME_KIND.INVOKE);
    expect(controller.snapshot().pendingCount).toBe(0);
    expect(controller.snapshot().outboundQueued).toBe(1);
    const committed = controller.transport.commitSent(frame, 2n);
    expect(packet).toEqual(Buffer.alloc(packet.length));
    expect(committed.snapshot.pendingCount).toBe(1);
    expect(committed.snapshot.outboundQueued).toBe(0);
  });

  it("commits exactly once and faults on replay, foreign token, or FIFO skip", () => {
    const controller = active();
    requestInvoke(controller, 1);
    const second = requestInvoke(controller, 2);
    const secondToken = sendFrame(second);
    const skipped = controller.transport.takeForSend(secondToken, 2n);
    expect(skipped.packet).toBeUndefined();
    expect(skipped.result.snapshot.fault).toBe("outbound-take-binding");

    const exact = active();
    const token = sendFrame(requestInvoke(exact, 3));
    expect(exact.transport.takeForSend(token, 2n).packet).toBeDefined();
    expect(exact.transport.commitSent(token, 2n).snapshot.pendingCount).toBe(1);
    const replay = exact.transport.commitSent(token, 2n);
    expect(replay.snapshot.phase).toBe("STOPPING");
    expect(replay.snapshot.fault).toBe("outbound-commit-fifo-or-replay");

    const owner = active();
    const foreign = sendFrame(requestInvoke(owner, 4));
    const victim = active();
    expect(victim.transport.takeForSend(foreign, 2n).packet).toBeUndefined();
    expect(victim.snapshot().phase).toBe("STOPPING");
  });

  it.each([100n, 101n])("rechecks INVOKE deadline at atomic take time %s", (nowNs) => {
    const controller = active();
    const token = sendFrame(requestInvoke(controller, 1, 2n, 100n));
    const taken = controller.transport.takeForSend(token, nowNs);
    expect(taken.packet).toBeUndefined();
    expect(taken.result.snapshot.phase).toBe("STOPPING");
    expect(taken.result.snapshot.fault).toBe("expired-outbound-obligation");
  });

  it("rechecks CANCEL retained binding without extending authority for pinned storage", () => {
    const expiresNs = 10n + TERMINAL_GRACE_NS;
    const stale = active();
    invoke(stale, 1);
    const cancelled = stale.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(1),
      cause: "cancel",
      nowNs: 10n,
    });
    const staleToken = sendFrame(cancelled);
    expect(stale.transport.takeForSend(staleToken, expiresNs).packet).toBeUndefined();

    const pinned = active();
    invoke(pinned, 2);
    const cancel = pinned.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(2),
      cause: "cancel",
      nowNs: 10n,
    });
    admit(
      pinned,
      "pinned-result",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(2), deadlineNs: 1_000n },
      expiresNs - 1n,
    );
    const token = sendFrame(cancel);
    const expiredPinned = pinned.transport.takeForSend(token, expiresNs + 1n);
    expect(expiredPinned.packet).toBeUndefined();
    expect(expiredPinned.result.snapshot.fault).toBe("expired-outbound-obligation");
  });

  it("makes failed or ambiguous transport outcomes terminal without reusing sequence", () => {
    const controller = active();
    const requested = requestInvoke(controller, 1);
    const token = sendFrame(requested);
    const packet = controller.transport.takeForSend(token, 2n).packet!;
    expect(packet[6]).toBe(FRAME_KIND.INVOKE);
    const failed = controller.dispatch({ type: "LOCAL_FAULT", reason: "lifecycle-fault" });
    expect(packet).toEqual(Buffer.alloc(packet.length));
    expect(failed.snapshot.phase).toBe("STOPPING");
    expect(failed.snapshot.outboundQueued).toBe(0);
    expect(controller.transport.takeForSend(token, 2n).packet).toBeUndefined();
  });
});
