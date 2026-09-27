import { describe, expect, it } from "vitest";
import {
  installSessionGeneration,
  type SessionIngressPort,
  type SessionLifecyclePort,
  type SessionObserver,
  type SessionTransportPort,
  type SessionWorkPort,
} from "./session-fsm.js";
import {
  FRAME_KIND,
  active,
  cleanup,
  deliver,
  epochHex,
  requestInvoke,
  sendFrame,
  startDrain,
  testFacets,
} from "./session-fsm.test-helpers.js";

type Facets = {
  observer: SessionObserver;
  work: SessionWorkPort;
  ingress: SessionIngressPort;
  transport: SessionTransportPort;
  lifecycle: SessionLifecyclePort;
};

function installWith(deliverKeyInstall: (packet: Buffer) => boolean): Facets {
  const bound: Partial<Facets> = {};
  installSessionGeneration(
    { generation: 1n, bootEpoch: epochHex },
    {
      clock: { nowNs: () => 1n },
      deliverKeyInstall,
      bindObserver(port) {
        bound.observer = port;
      },
      bindWork(port) {
        bound.work = port;
      },
      bindIngress(port) {
        bound.ingress = port;
      },
      bindTransport(port) {
        bound.transport = port;
      },
      bindLifecycle(port) {
        bound.lifecycle = port;
      },
    },
  );
  return bound as Facets;
}

describe("C07 lifecycle and capability authority", () => {
  it("fences reentrant key delivery before a second callback or key", () => {
    const holder: { facets?: Facets } = {};
    let calls = 0;
    let alias!: Buffer;
    const facets = installWith((packet) => {
      calls += 1;
      alias = packet;
      expect(holder.facets!.lifecycle.attested().snapshot.phase).toBe("STOPPING");
      return true;
    });
    holder.facets = facets;
    expect(facets.lifecycle.connected().snapshot.phase).toBe("ATTESTING");
    const result = facets.lifecycle.attested();
    expect(calls).toBe(1);
    expect(alias).toEqual(Buffer.alloc(alias.length));
    expect(result.snapshot.phase).toBe("STOPPING");
    expect(result.snapshot.fault).toBe("key-install");
  });

  it("zeroizes key packets and bounds adapter exception faults", () => {
    let alias!: Buffer;
    let leaked = "";
    const facets = installWith((packet) => {
      alias = packet;
      leaked = packet.toString("hex");
      throw new Error(leaked);
    });
    facets.lifecycle.connected();
    const result = facets.lifecycle.attested();
    expect(alias).toEqual(Buffer.alloc(alias.length));
    expect(result.snapshot.fault).toBe("key-install");
    expect(JSON.stringify(result.snapshot)).not.toContain(leaked);
    expect(result.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
  });

  it("keeps recovery terminal under stale transport and lifecycle facets", () => {
    const controller = active();
    const token = sendFrame(requestInvoke(controller, 1));
    const facets = testFacets(controller);
    facets.lifecycle.cleanupUncertain();
    const before = facets.observer.snapshot();
    expect(before.phase).toBe("RECOVERY_REQUIRED");
    expect(facets.transport.commitSent(token).snapshot).toEqual(before);
    expect(facets.lifecycle.cleanupProgress(cleanup).snapshot).toEqual(before);
    expect(facets.lifecycle.exitProof().snapshot).toEqual(before);
    expect(facets.work.startDrain().snapshot).toEqual(before);
  });

  it("keeps verified exit terminal under every stale facet", () => {
    const controller = active();
    startDrain(controller, 10n);
    deliver(controller, "ack", { kind: FRAME_KIND.CLOSE_ACK }, { nowNs: 11n });
    const facets = testFacets(controller);
    facets.lifecycle.cleanupProgress(cleanup);
    expect(facets.lifecycle.exitProof().snapshot.phase).toBe("EXIT_VERIFIED");
    const before = facets.observer.snapshot();
    const foreign = sendFrame(requestInvoke(active(), 9));
    expect(facets.transport.commitSent(foreign).snapshot).toEqual(before);
    expect(facets.lifecycle.cleanupUncertain().snapshot).toEqual(before);
    expect(facets.work.startDrain().snapshot).toEqual(before);
  });

  it("rejects an all-zero request ID without throwing from the work facet", () => {
    const facets = testFacets(active());
    const result = facets.work.invoke({
      requestId: "0".repeat(32),
      deadlineNs: 1_000n,
      body: Buffer.from([1]),
    });
    expect(result.snapshot.phase).toBe("STOPPING");
    expect(result.snapshot.fault).toBe("invoke-admission");

    const terminal = testFacets(active()).work.terminal({
      requestId: "0".repeat(32),
      cause: "cancel",
    });
    expect(terminal.snapshot.phase).toBe("STOPPING");
    expect(terminal.snapshot.fault).toBe("request-id");
  });
});
