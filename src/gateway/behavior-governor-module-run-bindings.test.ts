import { describe, expect, it, vi } from "vitest";
import type { GovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
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
  return {
    resolveRunScope: vi.fn(() => scope()),
    freeze: vi.fn(),
    close,
  };
}

function binding(
  authority: ReturnType<typeof createGatewayBehaviorGovernorModuleRunBindingAuthority>,
) {
  return authority.createRunBinding({
    run: run(),
    planDigest: "a".repeat(64),
    plan: Object.freeze({ branded: true }),
  });
}

describe("gateway behavior governor module run bindings", () => {
  it("consumes one exact process-local token for its activation and run", () => {
    const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    const issued = binding(authority);
    const owned = provider();

    expect(Object.isFrozen(issued.token)).toBe(true);
    expect(Object.keys(issued.token)).toEqual([]);
    expect(
      authority.resolveRunScope({ activation, run: run({ now: 99 }) }, issued.token, owned),
    ).toBeDefined();
    expect(owned.resolveRunScope).toHaveBeenCalledOnce();
    expect(() =>
      authority.resolveRunScope({ activation, run: run() }, issued.token, provider()),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    authority.close();
  });

  it.each([
    { name: "run", input: { runId: "run-2" } },
    { name: "session", input: { sessionId: "session-2" } },
    { name: "source", input: { sourceMessageId: "message-2" } },
    { name: "sequence", input: { sourceSequence: 4 } },
    { name: "prompt", input: { prompt: "substituted" } },
  ])("rejects a substituted $name identity", ({ input }) => {
    const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    const issued = binding(authority);
    expect(() =>
      authority.resolveRunScope({ activation, run: run(input) }, issued.token, provider()),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    issued.close();
  });

  it("rejects another activation, authority, forged token, and post-freeze consumption", () => {
    const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    const other = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    const issued = binding(authority);
    expect(() =>
      authority.resolveRunScope(
        { activation: { ...activation, id: "c03" }, run: run() },
        issued.token,
        provider(),
      ),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    expect(() =>
      other.resolveRunScope({ activation, run: run() }, issued.token, provider()),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    expect(() =>
      authority.resolveRunScope({ activation, run: run() }, Object.freeze({}) as never, provider()),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_INVALID");
    authority.freeze();
    expect(() =>
      authority.resolveRunScope({ activation, run: run() }, issued.token, provider()),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_FROZEN");
    authority.close();
  });

  it("requires a frozen opaque plan and lowercase SHA-256 digest", () => {
    const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    expect(() =>
      authority.createRunBinding({
        run: run(),
        planDigest: "A".repeat(64),
        plan: Object.freeze({}),
      }),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_PLAN_INVALID");
    expect(() =>
      authority.createRunBinding({ run: run(), planDigest: "a".repeat(64), plan: {} }),
    ).toThrow("GOVERNOR_MODULE_RUN_BINDING_PLAN_INVALID");
  });

  it("retains a consumed provider whose close fails and retries it", () => {
    let failures = 1;
    const close = vi.fn(() => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("close failed");
      }
    });
    const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
    const issued = binding(authority);
    authority.resolveRunScope({ activation, run: run() }, issued.token, provider(close));

    expect(() => authority.close()).toThrow("GOVERNOR_MODULE_RUN_BINDING_CLOSE_FAILED");
    authority.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
