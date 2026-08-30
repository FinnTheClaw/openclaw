import { describe, expect, it, vi } from "vitest";
import type { GovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GatewayBehaviorGovernorModuleActivation } from "./behavior-governor-module-agent-loop.js";
import { createGatewayBehaviorGovernorModuleRunBindingAuthority } from "./behavior-governor-module-run-bindings.js";

const activation: GatewayBehaviorGovernorModuleActivation = {
  id: "c02",
  mode: "enforce",
  version: "1.0.0",
};

function run(overrides: Partial<GovernorAgentLoopRunInput> = {}): GovernorAgentLoopRunInput {
  return {
    runId: "run-1",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    sourceSequence: 3,
    prompt: "verify exact state",
    now: 10,
    ...overrides,
  };
}

function scope(): GovernorAgentLoopRunScope {
  return {
    taskId: "task-1",
    mode: "enforce",
    beforeTool: () => ({ kind: "allow" }),
    afterTool: () => undefined,
    afterTurn: () => ({ kind: "complete" }),
    interrupt: () => undefined,
    assertTerminal: () => undefined,
    governedTools: () => [],
    dispose: () => undefined,
  };
}

function provider(close = vi.fn()): GovernorAgentLoopScopeProvider {
  return { resolveRunScope: vi.fn(() => scope()), freeze: vi.fn(), close };
}

function authority(owned = provider()) {
  return {
    owned,
    authority: createGatewayBehaviorGovernorModuleRunBindingAuthority({
      activation,
      provider: owned,
    }),
  };
}

function binding(
  target: ReturnType<typeof authority>["authority"],
  plan: unknown = { branded: true },
) {
  return target.createRunBinding({ run: run(), planDigest: governorDigest(plan as never), plan });
}

describe("gateway behavior governor module run bindings", () => {
  it("consumes one exact provider-bound process-local proof", () => {
    const first = authority();
    const issued = binding(first.authority);
    expect(Object.isFrozen(issued.proof.token)).toBe(true);
    expect(Object.keys(issued.proof.token)).toEqual([]);
    expect(
      first.authority.resolveRunScope({ activation, run: run({ now: 99 }) }, issued.proof),
    ).toBeDefined();
    expect(first.owned.resolveRunScope).toHaveBeenCalledOnce();
    expect(() => first.authority.resolveRunScope({ activation, run: run() }, issued.proof)).toThrow(
      "GOVERNOR_MODULE_RUN_BINDING_INVALID",
    );
    first.authority.close();
  });

  it.each([
    { name: "run", input: { runId: "run-2" } },
    { name: "session", input: { sessionId: "session-2" } },
    { name: "source", input: { sourceMessageId: "message-2" } },
    { name: "sequence", input: { sourceSequence: 4 } },
    { name: "prompt", input: { prompt: "substituted" } },
  ])("rejects a substituted $name identity", ({ input }) => {
    const target = authority();
    const issued = binding(target.authority);
    expect(() =>
      target.authority.resolveRunScope({ activation, run: run(input) }, issued.proof),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    issued.close();
    target.authority.close();
  });

  it("rejects provider substitution, another activation, and forged proof", () => {
    const first = authority();
    const second = authority();
    const issued = binding(first.authority);
    expect(() =>
      second.authority.resolveRunScope({ activation, run: run() }, issued.proof),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    expect(() =>
      first.authority.resolveRunScope(
        { activation: { ...activation, id: "c03" }, run: run() },
        issued.proof,
      ),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    expect(() =>
      first.authority.resolveRunScope(
        { activation, run: run() },
        { ...issued.proof, plan: { branded: true } },
      ),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    issued.close();
    first.authority.close();
    second.authority.close();
  });

  it("canonicalizes and deep-freezes the plan before binding it", () => {
    const target = authority();
    const original = { z: { values: [1, { ok: true }] }, a: "first" };
    const issued = binding(target.authority, original);
    original.z.values[1] = { ok: false };
    expect(issued.proof.plan).toEqual({ a: "first", z: { values: [1, { ok: true }] } });
    expect(Object.isFrozen(issued.proof.plan)).toBe(true);
    expect(Object.isFrozen((issued.proof.plan as { z: { values: unknown[] } }).z.values)).toBe(
      true,
    );
    expect(
      target.authority.resolveRunScope({ activation, run: run() }, issued.proof),
    ).toBeDefined();
    target.authority.close();
  });

  it("rejects arbitrary, uppercase, and non-canonical plan digests", () => {
    const target = authority();
    for (const planDigest of ["a".repeat(64), "A".repeat(64), governorDigest({ other: true })]) {
      expect(() =>
        target.authority.createRunBinding({ run: run(), planDigest, plan: { branded: true } }),
      ).toThrow("GOVERNOR_MODULE_RUN_BINDING_PLAN_INVALID");
    }
    target.authority.close();
  });

  it("retains a consumed provider whose close fails and retries it", () => {
    let failures = 1;
    const close = vi.fn(() => {
      if (failures-- > 0) {
        throw new Error("close failed");
      }
    });
    const target = authority(provider(close));
    const issued = binding(target.authority);
    target.authority.resolveRunScope({ activation, run: run() }, issued.proof);
    expect(() => target.authority.close()).toThrow("GOVERNOR_MODULE_RUN_BINDING_CLOSE_FAILED");
    target.authority.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
