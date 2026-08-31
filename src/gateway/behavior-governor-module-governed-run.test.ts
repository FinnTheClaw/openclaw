import { describe, expect, it, vi } from "vitest";
import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
import type { GatewayBehaviorGovernorModuleRunInput } from "./behavior-governor-module-agent-loop.js";
import { createGatewayBehaviorGovernorModuleGovernedRunConsumer } from "./behavior-governor-module-governed-run.js";
import type { GatewayBehaviorGovernorModuleActivationContext } from "./behavior-governor-module-lifecycle.js";

const activation = Object.freeze({ id: "fixture-module", mode: "enforce" as const, version: "v1" });

function run(): GovernorAgentLoopRunInput {
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
    sourceSequence: 1,
    prompt: "run exact fixture",
    now: 1,
  };
}

function scope(dispose = vi.fn()): GovernorAgentLoopRunScope {
  return {
    taskId: "task-1",
    mode: "enforce",
    beforeTool: () => ({ kind: "allow" }),
    afterTool: () => undefined,
    afterTurn: () => ({ kind: "complete" }),
    interrupt: () => undefined,
    assertTerminal: () => undefined,
    governedTools: () => [],
    dispose,
  };
}

function configuration(
  overrides: Partial<GovernorAgentLoopConfiguration> = {},
): GovernorAgentLoopConfiguration {
  return {
    moduleIdentity: { id: activation.id, version: activation.version },
    hostCapabilities: { installedToolInventory: true, toolTurnProvenance: true },
    mode: activation.mode,
    scopes: [{ sessionKey: "agent:main:main", agentId: "main" }],
    criteria: [],
    toolBindings: [],
    maxTurns: 1,
    ...overrides,
  } as GovernorAgentLoopConfiguration;
}

function fixture(params: { declined?: boolean; resolved?: GovernorAgentLoopRunScope } = {}) {
  const bindingClose = vi.fn();
  const providerClose = vi.fn();
  const binding = Object.freeze({ proof: Object.freeze({}), close: bindingClose });
  const provider = Object.freeze({
    createRunBinding: vi.fn(() => binding),
    resolveRunScope: vi.fn(() => (params.declined ? undefined : (params.resolved ?? scope()))),
    freeze: vi.fn(),
    close: providerClose,
  });
  const context: GatewayBehaviorGovernorModuleActivationContext = Object.freeze({
    ...activation,
    host: Object.freeze({
      agentLoop: Object.freeze({
        createScopeProvider: vi.fn(() => provider),
      }),
    }),
  }) as unknown as GatewayBehaviorGovernorModuleActivationContext;
  const definition = Object.freeze({
    config: vi.fn(() => configuration()),
    plan: Object.freeze({ schema: "fixture/v1" }),
    planDigest: "a".repeat(64),
  });
  const consumer = createGatewayBehaviorGovernorModuleGovernedRunConsumer(context, definition);
  const input: GatewayBehaviorGovernorModuleRunInput = Object.freeze({ activation, run: run() });
  return { bindingClose, consumer, context, definition, input, provider, providerClose };
}

describe("gateway behavior governor module governed run consumer", () => {
  it("binds one configured run to the host and releases its transient authority on disposal", () => {
    const target = fixture();
    const resolved = target.consumer.agentLoop?.resolveRunScope(target.input);

    expect(resolved).toBeDefined();
    expect(target.context.host.agentLoop.createScopeProvider).toHaveBeenCalledWith(configuration());
    expect(target.provider.createRunBinding).toHaveBeenCalledWith({
      run: target.input.run,
      plan: target.definition.plan,
      planDigest: target.definition.planDigest,
    });

    resolved?.dispose();
    expect(target.bindingClose).toHaveBeenCalledOnce();
    expect(target.providerClose).toHaveBeenCalledOnce();
  });

  it("releases a binding when the host declines the run", () => {
    const target = fixture({ declined: true });

    expect(target.consumer.agentLoop?.resolveRunScope(target.input)).toBeUndefined();
    expect(target.bindingClose).toHaveBeenCalledOnce();
    expect(target.providerClose).toHaveBeenCalledOnce();
  });

  it("rejects a module configuration that does not match its host-issued activation", () => {
    const target = fixture();
    target.definition.config.mockReturnValueOnce(
      configuration({ moduleIdentity: { id: "other", version: activation.version } }),
    );

    expect(() => target.consumer.agentLoop?.resolveRunScope(target.input)).toThrow(
      "GOVERNOR_MODULE_GOVERNED_RUN_CONFIGURATION_MISMATCH",
    );
    expect(target.context.host.agentLoop.createScopeProvider).not.toHaveBeenCalled();
  });

  it("reports a scope disposal failure only after releasing its binding and provider", () => {
    const dispose = vi.fn<GovernorAgentLoopRunScope["dispose"]>().mockImplementationOnce(() => {
      throw new Error("dispose failed");
    });
    const target = fixture({ resolved: scope(dispose) });
    target.consumer.agentLoop?.resolveRunScope(target.input);

    expect(() => target.consumer.close()).toThrow(
      "GOVERNOR_MODULE_GOVERNED_RUN_CONSUMER_CLOSE_FAILED",
    );
    expect(target.bindingClose).toHaveBeenCalledOnce();
    expect(target.providerClose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
