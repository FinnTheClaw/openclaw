import { describe, expect, it } from "vitest";
import {
  FRAME_KIND,
  TERMINAL_GRACE_NS,
  active,
  admit,
  completeSend,
  invoke,
  requestHex,
  requestInvoke,
  sendFrame,
} from "./session-fsm.test-helpers.js";

describe("C07 terminal admission and expiry ownership", () => {
  it.each(["cancel", "timeout"] as const)(
    "makes admitted RESULT authoritative before later local %s",
    (cause) => {
      const controller = active();
      invoke(controller, 1);
      const admitted = admit(
        controller,
        "winner",
        { kind: FRAME_KIND.RESULT, requestId: requestHex(1), deadlineNs: 1_000n },
        3n,
      );
      expect(admitted.snapshot.pendingCount).toBe(0);
      expect(admitted.snapshot.tombstoneCount).toBe(1);
      const losing = controller.dispatch({
        type: "LOCAL_TERMINAL",
        requestId: requestHex(1),
        cause,
        nowNs: cause === "timeout" ? 1_000n : 4n,
      });
      expect(losing.actions).toEqual([{ type: "DISCARD_LOSING_TERMINAL" }]);
      expect(losing.snapshot.outboundQueued).toBe(0);
      const processed = controller.processInbound("winner", { nowNs: 1_000n });
      expect(processed.actions).toEqual([]);
      expect(processed.snapshot.pendingCount).toBe(0);
      expect(processed.snapshot.tombstoneCount).toBe(1);
    },
  );

  it("gives a delayed winner proof no authority over a reused request ID", () => {
    const controller = active();
    invoke(controller, 2);
    admit(
      controller,
      "old-winner",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(2), deadlineNs: 1_000n },
      3n,
    );
    const expiresNs = 3n + TERMINAL_GRACE_NS;
    completeSend(controller, requestInvoke(controller, 2, expiresNs, expiresNs + 100n), expiresNs);
    const processed = controller.processInbound("old-winner", { nowNs: expiresNs + 1n });
    expect(processed.actions).toEqual([]);
    expect(processed.snapshot.pendingCount).toBe(1);
    expect(processed.snapshot.tombstoneCount).toBe(0);
  });

  it("stops instead of skipping an expired provisional CANCEL sequence", () => {
    const controller = active();
    invoke(controller, 3);
    const cancelled = controller.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(3),
      cause: "cancel",
      nowNs: 10n,
    });
    const token = sendFrame(cancelled);
    const expiresNs = 10n + TERMINAL_GRACE_NS;
    const stopped = requestInvoke(controller, 3, expiresNs, expiresNs + 100n);
    expect(stopped.snapshot.phase).toBe("STOPPING");
    expect(stopped.snapshot.fault).toBe("expired-outbound-obligation");
    expect(stopped.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
    expect(controller.transport.takeForSend(token, expiresNs).packet).toBeUndefined();
  });

  it("zeroizes an expired consumed CANCEL but permits its exact commit first", () => {
    const ambiguous = active();
    invoke(ambiguous, 4);
    const ambiguousCancel = ambiguous.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(4),
      cause: "cancel",
      nowNs: 10n,
    });
    const ambiguousToken = sendFrame(ambiguousCancel);
    const expiresNs = 10n + TERMINAL_GRACE_NS;
    const packet = ambiguous.transport.takeForSend(ambiguousToken, expiresNs - 1n).packet!;
    requestInvoke(ambiguous, 5, expiresNs, expiresNs + 100n);
    expect(ambiguous.snapshot().phase).toBe("STOPPING");
    expect(packet).toEqual(Buffer.alloc(packet.length));

    const exact = active();
    invoke(exact, 6);
    const exactCancel = exact.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(6),
      cause: "cancel",
      nowNs: 10n,
    });
    const exactToken = sendFrame(exactCancel);
    exact.transport.takeForSend(exactToken, expiresNs - 1n);
    const committed = exact.transport.commitSent(exactToken, expiresNs);
    expect(committed.snapshot.phase).toBe("ACTIVE");
    expect(committed.snapshot.tombstoneCount).toBe(0);
    expect(committed.snapshot.outboundQueued).toBe(0);
    expect(requestInvoke(exact, 6, expiresNs, expiresNs + 100n).actions).toHaveLength(1);
  });

  it("stops when any installed INVOKE reaches its take deadline", () => {
    const controller = active();
    requestInvoke(controller, 7, 2n, 100n);
    const stopped = requestInvoke(controller, 8, 100n, 200n);
    expect(stopped.snapshot.phase).toBe("STOPPING");
    expect(stopped.snapshot.fault).toBe("expired-outbound-obligation");
  });
});
