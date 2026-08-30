import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import {
  clearGovernorAgentLoopInertRegistry,
  installGovernorAgentLoopInertRegistry,
} from "../security/governor-agent-loop-inert-registry.js";
import {
  isGovernorAgentLoopRunScope,
  resolveGovernorAgentLoopRunScope,
  type GovernorAgentLoopRunInput,
  type GovernorAgentLoopRunScope,
  type GovernorAgentLoopToolDecision,
  type GovernorAgentLoopTurnDecision,
} from "../security/governor-agent-loop-readonly.js";
import type { GatewayBehaviorGovernorModuleRunInput } from "./behavior-governor-module-agent-loop.js";
import {
  createGatewayBehaviorGovernorModuleLifecycle,
  type GatewayBehaviorGovernorModuleDescriptor,
} from "./behavior-governor-module-lifecycle.js";

const TEST_HOST_PROVIDER = {
  acquire: vi.fn(async () => ({
    capability: {
      forActivation: () => ({
        agentLoop: {
          createScopeProvider: () => {
            throw new Error("TEST_SCOPE_PROVIDER_UNUSED");
          },
          createRunBinding: () => {
            throw new Error("TEST_RUN_BINDING_UNUSED");
          },
        },
      }),
    },
    freeze: vi.fn(),
    close: vi.fn(),
  })),
};

function runInput(): GovernorAgentLoopRunInput {
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
    prompt: "Verify the exact state",
    now: 10,
  };
}

function selection(id: string, mode: BehaviorGovernorModuleSelection["mode"] = "enforce") {
  return { id, mode, version: "1.0.0" } as const;
}

function scope(params: {
  mode: BehaviorGovernorModuleSelection["mode"];
  beforeTool?: GovernorAgentLoopToolDecision;
  afterTurn?: GovernorAgentLoopTurnDecision;
  disposition?: GovernorAgentLoopRunScope["disposition"];
}): GovernorAgentLoopRunScope {
  const allow: GovernorAgentLoopToolDecision = { kind: "allow" };
  const complete: GovernorAgentLoopTurnDecision = { kind: "complete" };
  return {
    taskId: "module-task",
    mode: params.mode,
    disposition: params.disposition,
    beforeTool: vi.fn((): GovernorAgentLoopToolDecision => params.beforeTool ?? allow),
    afterTool: vi.fn(),
    afterTurn: vi.fn((): GovernorAgentLoopTurnDecision => params.afterTurn ?? complete),
    interrupt: vi.fn(),
    assertTerminal: vi.fn(),
    governedTools: vi.fn(() => []),
    dispose: vi.fn(),
  };
}

function descriptor(params: {
  id: string;
  mode?: BehaviorGovernorModuleSelection["mode"];
  resolve: (input: GatewayBehaviorGovernorModuleRunInput) => GovernorAgentLoopRunScope | undefined;
}): GatewayBehaviorGovernorModuleDescriptor {
  return {
    id: params.id,
    version: "1.0.0",
    supportedModes: [params.mode ?? "enforce"],
    qualifiedModes: [params.mode ?? "enforce"],
    dependencies: [],
    durableBoundaryIds: [],
    load: async () => async () => ({
      agentLoop: { resolveRunScope: params.resolve },
      close: vi.fn(),
    }),
  };
}

describe("gateway behavior governor module agent-loop consumer", () => {
  it("keeps an empty module plan registry-free", async () => {
    const item = descriptor({ id: "c06b", resolve: vi.fn() });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [item],
    });

    await lifecycle.apply([]);

    expect(resolveGovernorAgentLoopRunScope(runInput())).toBeUndefined();
    await lifecycle.close();
  });

  it("carries frozen trusted run context through the selected module", async () => {
    let received: GatewayBehaviorGovernorModuleRunInput | undefined;
    const component = scope({
      mode: "enforce",
      afterTurn: { kind: "continue", message: "verify" },
    });
    const item = descriptor({
      id: "c06b",
      resolve: (input) => {
        received = input;
        return component;
      },
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [item],
    });
    await lifecycle.apply([selection("c06b")]);

    const resolved = resolveGovernorAgentLoopRunScope(runInput());

    expect(resolved).toBeDefined();
    expect(isGovernorAgentLoopRunScope(resolved!)).toBe(true);
    expect(received).toEqual({
      activation: { id: "c06b", mode: "enforce", version: "1.0.0" },
      run: runInput(),
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.activation)).toBe(true);
    expect(Object.isFrozen(received?.run)).toBe(true);
    expect(resolved?.afterTurn({ assistantText: "", toolCallCount: 0, now: 11 })).toEqual({
      kind: "continue",
      message: "verify",
    });

    resolved?.dispose();
    await lifecycle.close();
    expect(resolveGovernorAgentLoopRunScope(runInput())).toBeUndefined();
  });

  it("prepares module scopes with the exact installed tool inventory", async () => {
    const installed = { name: "read" } as AgentTool;
    let prepared: readonly unknown[] | undefined;
    let governed: readonly AgentTool[] = [];
    const component = {
      ...scope({ mode: "enforce" }),
      prepareTools: vi.fn((tools: readonly AgentTool[]) => {
        prepared = tools;
        governed = tools;
      }),
      governedTools: vi.fn(() => governed),
    } satisfies GovernorAgentLoopRunScope;
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [descriptor({ id: "c02", resolve: () => component })],
    });
    await lifecycle.apply([selection("c02")]);
    const resolved = resolveGovernorAgentLoopRunScope(runInput())!;

    resolved.prepareTools?.([installed]);

    expect(prepared?.[0]).toBe(installed);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(resolved.governedTools()).toEqual([installed]);
    resolved.dispose();
    await lifecycle.close();
  });

  it("lets shadow modules observe without changing enforce decisions", async () => {
    const shadow = scope({
      mode: "shadow",
      beforeTool: { kind: "block", reasonCode: "SHADOW_BLOCK" },
      afterTurn: { kind: "stop", reasonCode: "SHADOW_STOP" },
    });
    const enforce = scope({
      mode: "enforce",
      afterTurn: { kind: "continue", message: "collect more evidence" },
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [
        descriptor({ id: "c01", mode: "shadow", resolve: () => shadow }),
        descriptor({ id: "c02", resolve: () => enforce }),
      ],
    });
    await lifecycle.apply([selection("c01", "shadow"), selection("c02")]);
    const resolved = resolveGovernorAgentLoopRunScope(runInput())!;

    expect(
      resolved.beforeTool({
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "allow" });
    expect(resolved.afterTurn({ assistantText: "", toolCallCount: 0, now: 12 })).toEqual({
      kind: "continue",
      message: "collect more evidence",
    });
    expect(shadow.beforeTool).toHaveBeenCalledOnce();
    expect(enforce.beforeTool).toHaveBeenCalledOnce();

    resolved.dispose();
    await lifecycle.close();
  });

  it("isolates deeply immutable before-tool arguments for every component", async () => {
    const actualArgs = { nested: { value: "pristine" } };
    const observations: unknown[] = [];
    const makeObserver = (mode: BehaviorGovernorModuleSelection["mode"]) => {
      return {
        ...scope({ mode }),
        beforeTool: vi.fn((input): GovernorAgentLoopToolDecision => {
          observations.push(input.args);
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.args)).toBe(true);
          expect(Object.isFrozen((input.args as typeof actualArgs).nested)).toBe(true);
          expect(Reflect.set((input.args as typeof actualArgs).nested, "value", "poison")).toBe(
            false,
          );
          return { kind: "allow" };
        }),
      } satisfies GovernorAgentLoopRunScope;
    };
    const shadow = makeObserver("shadow");
    const enforce = makeObserver("enforce");
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [
        descriptor({ id: "c01", mode: "shadow", resolve: () => shadow }),
        descriptor({ id: "c02", resolve: () => enforce }),
      ],
    });
    await lifecycle.apply([selection("c01", "shadow"), selection("c02")]);
    const resolved = resolveGovernorAgentLoopRunScope(runInput())!;

    expect(
      resolved.beforeTool({
        toolCallId: "tool-1",
        toolName: "read",
        args: actualArgs,
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "allow" });
    expect(actualArgs.nested.value).toBe("pristine");
    expect(observations).toHaveLength(2);
    expect(observations[0]).not.toBe(actualArgs);
    expect(observations[1]).not.toBe(actualArgs);
    expect(observations[0]).not.toBe(observations[1]);

    resolved.dispose();
    await lifecycle.close();
  });

  it("isolates deeply immutable after-tool results for every component", async () => {
    const actualResult = { content: [{ type: "text", text: "pristine" }], details: { count: 1 } };
    const observations: unknown[] = [];
    const makeObserver = (mode: BehaviorGovernorModuleSelection["mode"]) => {
      return {
        ...scope({ mode }),
        afterTool: vi.fn((input) => {
          observations.push(input.result);
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.result)).toBe(true);
          expect(Object.isFrozen((input.result as typeof actualResult).content)).toBe(true);
          expect(Object.isFrozen((input.result as typeof actualResult).content[0])).toBe(true);
          expect(
            Reflect.set((input.result as typeof actualResult).content[0], "text", "poison"),
          ).toBe(false);
        }),
      } satisfies GovernorAgentLoopRunScope;
    };
    const shadow = makeObserver("shadow");
    const enforce = makeObserver("enforce");
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [
        descriptor({ id: "c01", mode: "shadow", resolve: () => shadow }),
        descriptor({ id: "c02", resolve: () => enforce }),
      ],
    });
    await lifecycle.apply([selection("c01", "shadow"), selection("c02")]);
    const resolved = resolveGovernorAgentLoopRunScope(runInput())!;

    resolved.afterTool({
      toolCallId: "tool-1",
      toolName: "read",
      result: actualResult,
      isError: false,
      now: 11,
    });
    expect(actualResult.content[0]?.text).toBe("pristine");
    expect(observations).toHaveLength(2);
    expect(observations[0]).not.toBe(actualResult);
    expect(observations[1]).not.toBe(actualResult);
    expect(observations[0]).not.toBe(observations[1]);

    resolved.dispose();
    await lifecycle.close();
  });

  it("fails closed on conflicting enforce turn directives", async () => {
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [
        descriptor({
          id: "c01",
          resolve: () => scope({ mode: "enforce", afterTurn: { kind: "continue", message: "a" } }),
        }),
        descriptor({
          id: "c02",
          resolve: () => scope({ mode: "enforce", afterTurn: { kind: "continue", message: "b" } }),
        }),
      ],
    });
    await lifecycle.apply([selection("c01"), selection("c02")]);
    const resolved = resolveGovernorAgentLoopRunScope(runInput())!;

    expect(() => resolved.afterTurn({ assistantText: "", toolCallCount: 0, now: 12 })).toThrow(
      "GOVERNOR_MODULE_AGENT_LOOP_DECISION_CONFLICT",
    );

    resolved.dispose();
    await lifecycle.close();
  });

  it("rejects a module that attempts to own completed replay", async () => {
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [
        descriptor({
          id: "c01",
          resolve: () => scope({ mode: "enforce", disposition: "completed_replay" }),
        }),
      ],
    });
    await lifecycle.apply([selection("c01")]);

    expect(() => resolveGovernorAgentLoopRunScope(runInput())).toThrow(
      "GOVERNOR_MODULE_AGENT_LOOP_REPLAY_OWNER_FORBIDDEN",
    );

    await lifecycle.close();
  });

  it("does not overwrite an already active agent-loop owner", async () => {
    const original = scope({ mode: "enforce" });
    const token = installGovernorAgentLoopInertRegistry({
      resolveScope: () => original,
      resolveCompletedReplay: () => undefined,
      isScope: (candidate) => candidate === original,
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider: TEST_HOST_PROVIDER,
      catalog: [descriptor({ id: "c01", resolve: () => scope({ mode: "enforce" }) })],
    });
    try {
      await expect(lifecycle.apply([selection("c01")])).rejects.toThrow(
        "GOVERNOR_AGENT_LOOP_REGISTRY_ALREADY_ACTIVE",
      );
      expect(resolveGovernorAgentLoopRunScope(runInput())).toBe(original);
    } finally {
      await lifecycle.close();
      clearGovernorAgentLoopInertRegistry(token);
    }
  });
});
