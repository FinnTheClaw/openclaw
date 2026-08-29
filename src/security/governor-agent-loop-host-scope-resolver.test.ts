import { describe, expect, it, vi } from "vitest";
import { createGovernorAgentLoopScopeResolver } from "./governor-agent-loop-host-scope-resolver.js";

type Host = Readonly<{ mode: "enforce" | "shadow" }>;

describe("governor agent-loop host scope resolver", () => {
  it("does not create a scope before active, admission, and selection checks pass", () => {
    const createScope = vi.fn(() => "scope");
    const resolve = createGovernorAgentLoopScopeResolver({
      active: () => ({ mode: "enforce" }) as Host,
      admitted: () => false,
      selected: () => true,
      createScope,
      isShadow: () => false,
    });

    expect(resolve({ runId: "run" })).toBeUndefined();
    expect(createScope).not.toHaveBeenCalled();
  });

  it("returns the host-created scope when the boundary admits and selects it", () => {
    const host: Host = { mode: "enforce" };
    const resolve = createGovernorAgentLoopScopeResolver({
      active: () => host,
      admitted: (value) => value === host,
      selected: (_value, input) => input.runId === "selected",
      createScope: (_value, input) => ({ taskId: input.runId }),
      isShadow: () => false,
    });

    expect(resolve({ runId: "selected" })).toEqual({ taskId: "selected" });
    expect(resolve({ runId: "other" })).toBeUndefined();
  });

  it("contains scope-construction faults only in shadow mode", () => {
    const shadow = createGovernorAgentLoopScopeResolver({
      active: () => ({ mode: "shadow" }) as Host,
      admitted: () => true,
      selected: () => true,
      createScope: () => {
        throw new Error("fixture");
      },
      isShadow: (host) => host.mode === "shadow",
    });
    const enforce = createGovernorAgentLoopScopeResolver({
      active: () => ({ mode: "enforce" }) as Host,
      admitted: () => true,
      selected: () => true,
      createScope: () => {
        throw new Error("fixture");
      },
      isShadow: (host) => host.mode === "shadow",
    });

    expect(shadow({ runId: "shadow" })).toBeUndefined();
    expect(() => enforce({ runId: "enforce" })).toThrow("fixture");
  });
});
