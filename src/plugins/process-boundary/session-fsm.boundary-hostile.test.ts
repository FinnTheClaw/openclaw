import { describe, expect, it } from "vitest";
import type { PreparedFrame } from "./frame-codec.js";
import type {
  SessionIngressPort,
  SessionLifecyclePort,
  SessionObserver,
  SessionTransportPort,
  SessionWorkPort,
} from "./session-capabilities.js";
import { installSessionGeneration } from "./session-fsm.js";
import {
  FRAME_KIND,
  active,
  cleanup,
  deliver,
  epochHex,
  startDrain,
  testFacets,
} from "./session-fsm.test-helpers.js";
import type { TestFacets } from "./session-test-harness.js";

function bindAll(clock: () => bigint): TestFacets {
  const bound: Partial<TestFacets> = {};
  installSessionGeneration(
    { generation: 77n, bootEpoch: epochHex },
    {
      clock: { nowNs: clock },
      deliverKeyInstall: () => true,
      bindObserver: (port) => (bound.observer = port),
      bindWork: (port) => (bound.work = port),
      bindIngress: (port) => (bound.ingress = port),
      bindTransport: (port) => (bound.transport = port),
      bindLifecycle: (port) => (bound.lifecycle = port),
    },
  );
  return bound as TestFacets;
}

function exerciseHostileStaleFacets(facets: TestFacets): number {
  let getterCalls = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        getterCalls += 1;
        throw new Error("secret-stale-input");
      },
    },
  );
  const packet = new Proxy(new Uint8Array(128), {
    get() {
      getterCalls += 1;
      throw new Error("secret-stale-packet");
    },
  });
  const frame = new Proxy(
    {},
    {
      get() {
        getterCalls += 1;
        throw new Error("secret-stale-frame");
      },
    },
  ) as PreparedFrame;
  const before = facets.observer.snapshot();
  expect(facets.work.invoke(hostile as never).snapshot).toEqual(before);
  expect(facets.work.terminal(hostile as never).snapshot).toEqual(before);
  expect(facets.ingress.admit(packet, "stale").snapshot).toEqual(before);
  expect(facets.ingress.process("stale", hostile).snapshot).toEqual(before);
  expect(facets.transport.takeForSend(frame).result.snapshot).toEqual(before);
  expect(facets.transport.commitSent(frame).snapshot).toEqual(before);
  expect(facets.lifecycle.cleanupProgress(hostile).snapshot).toEqual(before);
  return getterCalls;
}

describe("C07 hostile mutation boundaries", () => {
  it("fences binding-time facet reentry and aborts later binders", () => {
    let observer: SessionObserver | undefined;
    const order: string[] = [];
    expect(() =>
      installSessionGeneration(
        { generation: 78n, bootEpoch: epochHex },
        {
          clock: { nowNs: () => 1n },
          deliverKeyInstall: () => true,
          bindObserver(port) {
            order.push("observer");
            observer = port;
          },
          bindWork(port) {
            order.push("work");
            port.startDrain();
          },
          bindIngress(_port: SessionIngressPort) {
            order.push("ingress");
          },
          bindTransport(_port: SessionTransportPort) {
            order.push("transport");
          },
          bindLifecycle(_port: SessionLifecyclePort) {
            order.push("lifecycle");
          },
        },
      ),
    ).toThrowError("controller-reentry");
    expect(order).toEqual(["observer", "work"]);
    expect(observer!.snapshot()).toMatchObject({
      phase: "STOPPING",
      fault: "controller-reentry",
    });
  });

  it("bounds binding exceptions without leaking adapter text", () => {
    let observer: SessionObserver | undefined;
    const install = () =>
      installSessionGeneration(
        { generation: 79n, bootEpoch: epochHex },
        {
          clock: { nowNs: () => 1n },
          deliverKeyInstall: () => true,
          bindObserver(port) {
            observer = port;
          },
          bindWork(_port: SessionWorkPort) {
            throw new Error("secret-binding-identity");
          },
          bindIngress: () => undefined,
          bindTransport: () => undefined,
          bindLifecycle: () => undefined,
        },
      );
    expect(install).toThrowError("capability-binding");
    expect(observer!.snapshot()).toMatchObject({ phase: "STOPPING", fault: "capability-binding" });
    expect(JSON.stringify(observer!.snapshot())).not.toContain("secret-binding-identity");
  });

  it("touches no hostile input or clock after recovery becomes terminal", () => {
    let clockCalls = 0;
    const facets = bindAll(() => {
      clockCalls += 1;
      throw new Error("secret-stale-clock");
    });
    expect(facets.lifecycle.cleanupUncertain().snapshot.phase).toBe("RECOVERY_REQUIRED");
    expect(exerciseHostileStaleFacets(facets)).toBe(0);
    expect(clockCalls).toBe(0);
  });

  it("touches no hostile input after verified exit becomes terminal", () => {
    const controller = active();
    startDrain(controller, 10n);
    deliver(controller, "ack", { kind: FRAME_KIND.CLOSE_ACK }, { nowNs: 11n });
    const facets = testFacets(controller);
    facets.lifecycle.cleanupProgress(cleanup);
    expect(facets.lifecycle.exitProof().snapshot.phase).toBe("EXIT_VERIFIED");
    expect(exerciseHostileStaleFacets(facets)).toBe(0);
  });
});
