import { describe, expect, it } from "vitest";
import { installSessionGeneration, type Cleanup, type ControllerResult } from "./session-fsm.js";
import {
  FRAME_KIND,
  UINT64_MAX,
  active,
  cleanup,
  deliver,
  epochHex,
  invoke,
  requestHex,
  startDrain,
  testFacets,
} from "./session-fsm.test-helpers.js";
import type { TestFacets } from "./session-test-harness.js";

function stopClean(controller: ReturnType<typeof active>) {
  startDrain(controller, 10n);
  deliver(controller, "ack", { kind: FRAME_KIND.CLOSE_ACK }, { nowNs: 11n });
  expect(controller.snapshot().phase).toBe("STOPPING");
}

function expectReentry(result: ControllerResult): void {
  expect(result.snapshot).toMatchObject({
    phase: "STOPPING",
    fault: "controller-reentry",
    inboundQueued: 0,
    outboundQueued: 0,
  });
  expect(result.actions).toEqual([{ type: "CLOSE_AND_STOP" }]);
}

function bindWithClock(nowNs: () => bigint): TestFacets {
  const bound: Partial<TestFacets> = {};
  installSessionGeneration(
    { generation: 99n, bootEpoch: epochHex },
    {
      clock: { nowNs },
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

describe("C07 synchronous mutation boundary", () => {
  it("prevents a cleanup getter from rewriting nested verified exit", () => {
    const controller = active();
    stopClean(controller);
    const facets = testFacets(controller);
    let reentered = false;
    const hostile = new Proxy(
      {},
      {
        get() {
          if (!reentered) {
            reentered = true;
            facets.lifecycle.cleanupProgress(cleanup);
            facets.lifecycle.exitProof();
          }
          return false;
        },
      },
    ) as Partial<Cleanup>;
    const result = facets.lifecycle.cleanupProgress(hostile);
    expectReentry(result);
    expect(result.snapshot.cleanupCompleted).toBe(0);
  });

  it("allows reentrant read-only observation during owned cleanup capture", () => {
    const controller = active();
    stopClean(controller);
    const facets = testFacets(controller);
    let observations = 0;
    const observed = new Proxy(
      {},
      {
        get() {
          observations += 1;
          expect(facets.observer.snapshot().phase).toBe("STOPPING");
          return true;
        },
      },
    ) as Partial<Cleanup>;
    const result = facets.lifecycle.cleanupProgress(observed);
    expect(result.snapshot.cleanupCompleted).toBe(8);
    expect(result.snapshot).not.toHaveProperty("fault");
    expect(result.actions).toEqual([]);
    expect(observations).toBe(8);
    expect(facets.lifecycle.exitProof().snapshot.phase).toBe("EXIT_VERIFIED");
  });

  it("bounds throwing and invalid cleanup input without disclosing it", () => {
    const throwing = active();
    stopClean(throwing);
    const thrown = testFacets(throwing).lifecycle.cleanupProgress(
      new Proxy(
        {},
        {
          get() {
            throw new Error("secret-cleanup-identity");
          },
        },
      ) as Partial<Cleanup>,
    );
    expect(thrown.snapshot).toMatchObject({ phase: "STOPPING", fault: "facet-input" });
    expect(JSON.stringify(thrown)).not.toContain("secret-cleanup-identity");

    for (const invalid of [null, "true", 1, Symbol("secret")]) {
      const controller = active();
      stopClean(controller);
      const result = testFacets(controller).lifecycle.cleanupProgress({
        ingress: invalid,
      } as unknown as Partial<Cleanup>);
      expect(result.snapshot).toMatchObject({ fault: "facet-input", cleanupCompleted: 0 });
    }
  });

  it("invalidates hostile caller input across every argument-bearing facet", () => {
    const invokeController = active();
    const invokeFacets = testFacets(invokeController);
    const body = new Proxy(new Uint8Array([1]), {
      get(target, property) {
        if (property === "byteLength") {
          invokeFacets.lifecycle.fail();
        }
        return Reflect.get(target, property, target);
      },
    });
    expectReentry(invokeFacets.work.invoke({ requestId: requestHex(1), deadlineNs: 1_000n, body }));

    const terminalController = active();
    invoke(terminalController, 2);
    const terminalFacets = testFacets(terminalController);
    const terminal = new Proxy(
      { requestId: requestHex(2), cause: "cancel" as const },
      {
        get(target, property, receiver) {
          terminalFacets.lifecycle.fail();
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expectReentry(terminalFacets.work.terminal(terminal));

    const admitController = active();
    const admitFacets = testFacets(admitController);
    const packet = new Proxy(new Uint8Array(128), {
      get(target, property) {
        if (property === "byteLength") {
          admitFacets.lifecycle.fail();
        }
        return Reflect.get(target, property, target);
      },
    });
    expectReentry(admitFacets.ingress.admit(packet, "hostile"));

    const processController = active();
    const processFacets = testFacets(processController);
    const options = new Proxy(
      {},
      {
        get() {
          processFacets.lifecycle.fail();
          return true;
        },
      },
    );
    expectReentry(processFacets.ingress.process("hostile", options));
  });

  it("rejects invalid runtime clock values with one bounded fault", () => {
    const clocks: Array<readonly [string, () => bigint]> = [
      ["number", () => 1 as unknown as bigint],
      ["string", () => "1" as unknown as bigint],
      ["object", () => ({ secret: "clock" }) as unknown as bigint],
      ["negative", () => -1n],
      ["oversized", () => UINT64_MAX + 1n],
      [
        "throw",
        () => {
          throw new Error("secret-clock-identity");
        },
      ],
    ];
    for (const [name, clock] of clocks) {
      const result = bindWithClock(clock).work.startDrain();
      expect(result.snapshot, name).toMatchObject({ phase: "STOPPING", fault: "monotonic-clock" });
      expect(JSON.stringify(result), name).not.toContain("secret-clock-identity");
    }
  });

  it("fences instead of recursing when the clock callback enters a mutator", () => {
    const holder: { facets?: TestFacets } = {};
    let reenter = false;
    const facets = bindWithClock(() => {
      if (reenter) {
        holder.facets!.lifecycle.cleanupUncertain();
      }
      return 1n;
    });
    holder.facets = facets;
    reenter = true;
    expectReentry(facets.work.startDrain());
  });
});
