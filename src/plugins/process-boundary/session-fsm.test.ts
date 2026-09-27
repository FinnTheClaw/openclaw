import { describe, expect, it } from "vitest";
import { decodeKeyInstall } from "./bootstrap-codec.js";
import * as codecExports from "./frame-codec.js";
import * as controllerExports from "./session-fsm.js";
import {
  DRAIN_GRACE_NS,
  FRAME_KIND,
  TERMINAL_GRACE_NS,
  active,
  admit,
  cleanup,
  completeSend,
  deliver,
  inboundPacket,
  invoke,
  peerContext,
  requestHex,
  requestInvoke,
  sendFrame,
  startDrain,
  testFacets,
} from "./session-fsm.test-helpers.js";
import * as outboundExports from "./session-outbound.js";

describe("C07 private linear session controller", () => {
  it("exposes no ambient canonical or internal transition bypass", () => {
    for (const name of [
      "authorizePreparedFrame",
      "commitPreparedFrame",
      "consumePreparedPacket",
      "takeAuthenticatedFrame",
      "prepareOutboundFrame",
    ]) {
      expect(name in codecExports).toBe(false);
    }
    expect("transitionSession" in controllerExports).toBe(false);
    expect("createSession" in controllerExports).toBe(false);
    expect("createSessionController" in controllerExports).toBe(false);
    expect("bindGenerationCodec" in codecExports).toBe(false);
    expect("prepareOutbound" in outboundExports).toBe(false);
    expect("commitOutbound" in outboundExports).toBe(false);
    const controller = active();
    const facets = testFacets(controller);
    expect(new Set(Object.values(facets)).size).toBe(5);
    expect(Object.keys(facets.observer)).toEqual(["snapshot"]);
    expect(Object.keys(facets.work).toSorted()).toEqual(["invoke", "startDrain", "terminal"]);
    expect(Object.keys(facets.ingress).toSorted()).toEqual(["admit", "process"]);
    expect(Object.keys(facets.transport).toSorted()).toEqual(["commitSent", "takeForSend"]);
    expect(Object.keys(facets.lifecycle).toSorted()).toEqual([
      "attested",
      "cleanupProgress",
      "cleanupUncertain",
      "connected",
      "drainGraceExpired",
      "exitProof",
      "fail",
    ]);
    expect(Object.keys(controller).toSorted()).toEqual([
      "admitInbound",
      "dispatch",
      "processInbound",
      "snapshot",
      "transport",
    ]);
    expect(Object.keys(controller.transport).toSorted()).toEqual(["commitSent", "takeForSend"]);
  });

  it("keeps state, authenticated fields, reservations, and request bindings out of snapshots/actions", () => {
    const controller = active();
    const outbound = requestInvoke(controller, 1, 2n, 1_000n, Buffer.from([7, 8]));
    const snapshot = outbound.snapshot;
    const frame = sendFrame(outbound);
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const privateName of [
      "generation",
      "channelId",
      "bootEpoch",
      "nextSequence",
      "lastNowNs",
      "drainDeadlineNs",
    ]) {
      expect(privateName in snapshot).toBe(false);
    }
    expect(Object.keys(frame)).toEqual([]);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.values(snapshot).map(String).join("|")).not.toContain(requestHex(1));
    expect(outbound.actions.flatMap((item) => Object.keys(item))).toEqual(["type", "frame"]);
    expect("reservations" in snapshot).toBe(false);
    expect(Reflect.set(snapshot, "phase", "EXIT_VERIFIED")).toBe(false);
    expect(controller.snapshot().phase).toBe("ACTIVE");

    const packet = inboundPacket({
      controller,
      kind: FRAME_KIND.RESULT,
      requestId: requestHex(1),
      deadlineNs: 1_000n,
      body: Buffer.from("private-result"),
    });
    completeSend(controller, outbound, 2n);
    const admitted = controller.admitInbound(packet, "private", 3n);
    expect(Object.values(admitted.snapshot).map(String).join("|")).not.toContain("private-result");
    expect(admitted.actions).toEqual([]);
  });

  it("mints every external codec factory call as a wire-disjoint authority", () => {
    const controller = active();
    const live = peerContext(controller);
    const rogue = codecExports.createGenerationCodec({
      bootEpoch: live.bootEpoch,
      generation: live.generation,
    });
    let rogueKey: Buffer | undefined;
    rogue.deliverKeyInstall((packet) => {
      rogueKey = Buffer.from(decodeKeyInstall(packet).key);
      return true;
    });
    expect(rogue.channelId).not.toEqual(live.channelId);
    expect(rogueKey).not.toEqual(live.key);
    rogueKey?.fill(0);
    rogue.fence();
  });

  it("enforces inbound FIFO and lifecycle legality without caller-owned Session replay", () => {
    const controller = active();
    invoke(controller, 1);
    invoke(controller, 2);
    admit(
      controller,
      "first",
      {
        kind: FRAME_KIND.RESULT,
        requestId: requestHex(1),
        deadlineNs: 1_000n,
      },
      3n,
    );
    const second = controller.admitInbound(
      inboundPacket({
        controller,
        kind: FRAME_KIND.RESULT,
        requestId: requestHex(2),
        deadlineNs: 1_000n,
      }),
      "second",
      4n,
    );
    expect(second.snapshot.inboundQueued).toBe(2);
    const skipped = controller.processInbound("second", { nowNs: 4n });
    expect(skipped.snapshot.phase).toBe("STOPPING");
    expect(skipped.snapshot.fault).toBe("inbound-fifo");
  });

  it("pins one pre-expiry losing RESULT but rejects a second post-expiry arrival", () => {
    const controller = active();
    invoke(controller, 1);
    completeSend(
      controller,
      controller.dispatch({
        type: "LOCAL_TERMINAL",
        requestId: requestHex(1),
        cause: "cancel",
        nowNs: 10n,
      }),
      10n,
    );
    const expiresNs = 10n + TERMINAL_GRACE_NS;
    const first = admit(
      controller,
      "pinned",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(1), deadlineNs: 1_000n },
      expiresNs - 1n,
    );
    expect(first.snapshot.inboundQueued).toBe(1);
    const second = admit(
      controller,
      "post-expiry",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(1), deadlineNs: 1_000n },
      expiresNs,
    );
    expect(second.snapshot.phase).toBe("STOPPING");
    expect(second.snapshot.fault).toBe("authenticated-request-binding");

    const delayed = active();
    invoke(delayed, 2);
    completeSend(
      delayed,
      delayed.dispatch({
        type: "LOCAL_TERMINAL",
        requestId: requestHex(2),
        cause: "cancel",
        nowNs: 10n,
      }),
      10n,
    );
    admit(
      delayed,
      "crossing",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(2), deadlineNs: 1_000n },
      expiresNs - 1n,
    );
    const processed = delayed.processInbound("crossing", { nowNs: expiresNs + 1n });
    expect(processed.snapshot.phase).toBe("ACTIVE");
    expect(processed.actions).toEqual([{ type: "DISCARD_LOSING_TERMINAL" }]);
  });

  it("claims one loser at admission and gives its proof no reused-request authority", () => {
    const duplicate = active();
    invoke(duplicate, 1);
    duplicate.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(1),
      cause: "cancel",
      nowNs: 10n,
    });
    const expiresNs = 10n + TERMINAL_GRACE_NS;
    admit(
      duplicate,
      "claimed",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(1), deadlineNs: 1_000n },
      expiresNs - 2n,
    );
    expect(
      admit(
        duplicate,
        "second-loser",
        { kind: FRAME_KIND.RESULT, requestId: requestHex(1), deadlineNs: 1_000n },
        expiresNs - 1n,
      ).snapshot.fault,
    ).toBe("authenticated-request-binding");

    const reused = active();
    invoke(reused, 2);
    const cancel = reused.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(2),
      cause: "cancel",
      nowNs: 10n,
    });
    completeSend(reused, cancel, 10n);
    admit(
      reused,
      "old-loser",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(2), deadlineNs: 1_000n },
      expiresNs - 1n,
    );
    completeSend(reused, requestInvoke(reused, 2, expiresNs, expiresNs + 100n), expiresNs);
    const discarded = reused.processInbound("old-loser", { nowNs: expiresNs + 1n });
    expect(discarded.actions).toEqual([{ type: "DISCARD_LOSING_TERMINAL" }]);
    expect(discarded.snapshot.pendingCount).toBe(1);

    const sameCause = active();
    invoke(sameCause, 3);
    deliver(
      sameCause,
      "winner",
      { kind: FRAME_KIND.RESULT, requestId: requestHex(3), deadlineNs: 1_000n },
      { nowNs: 3n },
    );
    expect(
      admit(
        sameCause,
        "same-cause",
        { kind: FRAME_KIND.RESULT, requestId: requestHex(3), deadlineNs: 1_000n },
        4n,
      ).snapshot.fault,
    ).toBe("authenticated-request-binding");
  });

  it("fences before fault, uncertainty, grace stop, clean close, and fresh generation", () => {
    const faulted = active();
    const faultSend = requestInvoke(faulted, 1);
    const faultToken = sendFrame(faultSend);
    faulted.dispatch({ type: "LOCAL_FAULT", reason: "lifecycle-fault" });
    expect(faulted.transport.takeForSend(faultToken, 2n).packet).toBeUndefined();

    const uncertain = active();
    const uncertainToken = sendFrame(requestInvoke(uncertain, 2));
    uncertain.dispatch({ type: "LOCAL_CLEANUP_UNCERTAIN", reason: "cleanup-uncertain" });
    expect(uncertain.transport.takeForSend(uncertainToken, 2n).packet).toBeUndefined();

    const draining = active();
    invoke(draining, 3);
    const drain = startDrain(draining, 10n);
    expect(drain.snapshot.phase).toBe("DRAINING");
    const cancel = draining.dispatch({
      type: "LOCAL_TERMINAL",
      requestId: requestHex(3),
      cause: "cancel",
      nowNs: 10n + DRAIN_GRACE_NS - 1n,
    });
    const graceToken = sendFrame(cancel);
    const stopped = draining.dispatch({
      type: "LOCAL_DRAIN_GRACE_EXPIRED",
      nowNs: 10n + DRAIN_GRACE_NS,
    });
    expect(stopped.snapshot.phase).toBe("STOPPING");
    expect(stopped.actions).toEqual([{ type: "REJECT_PENDING_AND_FORCE_STOP" }]);
    expect(draining.transport.takeForSend(graceToken, 10n + DRAIN_GRACE_NS).packet).toBeUndefined();

    const clean = active();
    startDrain(clean, 10n);
    const closed = deliver(clean, "ack", { kind: FRAME_KIND.CLOSE_ACK }, { nowNs: 11n });
    expect(closed.snapshot.phase).toBe("STOPPING");
    clean.dispatch({ type: "LOCAL_CLEANUP_PROGRESS", completed: cleanup });
    expect(clean.dispatch({ type: "LOCAL_EXIT_PROOF" }).snapshot.phase).toBe("EXIT_VERIFIED");
    expect("restart" in clean).toBe(false);
    const next = active(undefined, 0, 2n);
    expect(peerContext(next).generation).toBe(2n);
    expect(peerContext(next).channelId).not.toEqual(peerContext(clean).channelId);
    expect(peerContext(next).key).not.toEqual(peerContext(clean).key);
  });
});
