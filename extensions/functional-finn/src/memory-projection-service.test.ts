import { describe, expect, it, vi } from "vitest";
import type { FunctionalFinnMemoryProjectionState } from "./memory-materializer.js";
import { FunctionalFinnMemoryProjectionService } from "./memory-projection-service.js";

function state(agentId: string): FunctionalFinnMemoryProjectionState {
  return {
    schemaVersion: 1,
    agentId,
    attemptId: "attempt",
    state: "applied",
    attempts: 1,
    attemptedAt: 1,
    appliedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Functional Finn projection service lifecycle", () => {
  it("makes startup reconciliation failure visible and keeps later work closed", async () => {
    const error = new Error("startup projection failed");
    const onError = vi.fn();
    const set = vi.fn();
    const service = new FunctionalFinnMemoryProjectionService(
      { reconcileAgent: vi.fn().mockRejectedValue(error) },
      ["finn"],
      onError,
      { set, clear: vi.fn() },
    );
    await expect(service.start()).rejects.toThrow(/memory projection failed/);
    expect(onError).toHaveBeenCalledWith("finn", error);
    expect(set).not.toHaveBeenCalled();
    await expect(service.reconcileAgent("finn")).rejects.toThrow(/while failed/);
    await expect(service.stop()).rejects.toThrow(/memory projection failed/);
    await expect(service.stop()).rejects.toThrow(/memory projection failed/);
  });

  it("freezes admission, drains active reconciliation, and closes idempotently", async () => {
    const held = deferred<FunctionalFinnMemoryProjectionState>();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(state("finn"))
      .mockImplementationOnce(() => held.promise);
    const clear = vi.fn();
    const timer = Symbol("timer");
    const service = new FunctionalFinnMemoryProjectionService(
      { reconcileAgent: reconcile },
      ["finn"],
      vi.fn(),
      { set: () => timer, clear },
    );
    await service.start();
    const active = service.reconcileAgent("finn");
    const closing = service.stop();
    await expect(service.reconcileAgent("finn")).rejects.toThrow(/while closing/);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    held.resolve(state("finn"));
    await expect(active).resolves.toMatchObject({ state: "applied" });
    await expect(closing).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it("fails close in a bounded deterministic way when a drain never settles", async () => {
    const held = deferred<FunctionalFinnMemoryProjectionState>();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(state("finn"))
      .mockImplementationOnce(() => held.promise);
    const timeoutCallbacks: Array<() => void> = [];
    const service = new FunctionalFinnMemoryProjectionService(
      { reconcileAgent: reconcile },
      ["finn"],
      vi.fn(),
      { set: () => 1, clear: vi.fn() },
      60_000,
      10,
      {
        set: (callback) => {
          timeoutCallbacks.push(callback);
          return callback;
        },
        clear: vi.fn(),
      },
    );
    await service.start();
    void service.reconcileAgent("finn").catch(() => undefined);
    const closing = service.stop();
    expect(timeoutCallbacks).toHaveLength(1);
    timeoutCallbacks[0]?.();
    await expect(closing).rejects.toThrow(/close timed out/);
    await expect(service.stop()).rejects.toThrow(/close timed out/);
    held.reject(new Error("late failure"));
  });

  it("closes deterministically when shutdown races initial reconciliation", async () => {
    const held = deferred<FunctionalFinnMemoryProjectionState>();
    const service = new FunctionalFinnMemoryProjectionService(
      { reconcileAgent: () => held.promise },
      ["finn"],
      vi.fn(),
      { set: vi.fn(), clear: vi.fn() },
    );
    const starting = service.start();
    const closing = service.stop();
    held.resolve(state("finn"));
    await expect(starting).rejects.toThrow(
      /finish startup while closing|finish startup while closed/,
    );
    await expect(closing).resolves.toBeUndefined();
    await expect(service.reconcileAgent("finn")).rejects.toThrow(/while closed/);
  });
});
