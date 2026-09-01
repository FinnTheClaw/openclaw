import { describe, expect, it, vi } from "vitest";
import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-readonly.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "../security/governor-c02-simple-efficiency-policy.js";
import {
  C02_BEHAVIOR_GOVERNOR_MODULE,
  C02_EVALUATION_SESSION_PREFIX,
} from "./behavior-governor-c02-module.js";
import type { GatewayBehaviorGovernorModuleRunBindingInput } from "./behavior-governor-module-run-bindings.js";

const ACTIVATION = Object.freeze({
  id: C02_SIMPLE_EFFICIENCY_ID,
  mode: "enforce" as const,
  version: C02_SIMPLE_EFFICIENCY_VERSION,
});

function run(sessionKey: string, runId = "run-1"): GovernorAgentLoopRunInput {
  return Object.freeze({
    runId,
    sessionKey,
    sessionId: "session-1",
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: "conversation-1",
    sourceMessageId: `message-${runId}`,
    prompt: `prompt-${runId}`,
    now: 10,
  });
}

function baseScope(
  params: {
    beforeTool?: GovernorAgentLoopRunScope["beforeTool"];
    afterTurn?: GovernorAgentLoopRunScope["afterTurn"];
  } = {},
): GovernorAgentLoopRunScope {
  return {
    taskId: "task-1",
    mode: "enforce",
    disposition: "runnable",
    beforeTool: params.beforeTool ?? vi.fn(() => ({ kind: "allow" })),
    afterTool: vi.fn(),
    afterTurn: params.afterTurn ?? vi.fn(() => ({ kind: "complete" })),
    interrupt: vi.fn(),
    assertTerminal: vi.fn(),
    governedTools: vi.fn(() => []),
    dispose: vi.fn(),
  };
}

async function harness(scopeFactory: () => GovernorAgentLoopRunScope = () => baseScope()) {
  const configurations: GovernorAgentLoopConfiguration[] = [];
  const bindings: GatewayBehaviorGovernorModuleRunBindingInput[] = [];
  const bindingCloses: ReturnType<typeof vi.fn>[] = [];
  const providerCloses: ReturnType<typeof vi.fn>[] = [];
  const factory = await C02_BEHAVIOR_GOVERNOR_MODULE.load();
  const runtime = await factory({
    ...ACTIVATION,
    host: {
      agentLoop: {
        createScopeProvider(configuration) {
          configurations.push(configuration);
          const providerClose = vi.fn();
          providerCloses.push(providerClose);
          return {
            createRunBinding(input) {
              bindings.push(input);
              const close = vi.fn();
              bindingCloses.push(close);
              return {
                proof: {
                  token: Object.freeze({}) as never,
                  planDigest: input.planDigest,
                  plan: input.plan as never,
                },
                close,
              };
            },
            resolveRunScope: () => scopeFactory(),
            freeze: vi.fn(),
            close: providerClose,
          };
        },
      },
    },
  });
  return { runtime, configurations, bindings, bindingCloses, providerCloses };
}

function moduleInput(sessionKey: string, runId?: string) {
  return Object.freeze({ activation: ACTIVATION, run: run(sessionKey, runId) });
}

function requiredScope(scope: GovernorAgentLoopRunScope | undefined): GovernorAgentLoopRunScope {
  expect(scope).toBeDefined();
  if (!scope) {
    throw new Error("expected C02 run scope");
  }
  return scope;
}

describe("C02 behavior governor module", () => {
  it("is inert for every ordinary Finn session", async () => {
    const test = await harness();

    expect(test.runtime.agentLoop?.resolveRunScope(moduleInput("agent:main:main"))).toBeUndefined();
    expect(test.configurations).toHaveLength(0);

    await test.runtime.close();
  });

  it("binds only an exact C02 evaluation session to case-scoped ordered actions", async () => {
    const test = await harness();
    const session = `${C02_EVALUATION_SESSION_PREFIX}C02-A-001:0123456789abcdef01234567`;
    const scope = test.runtime.agentLoop?.resolveRunScope(moduleInput(session));

    expect(scope).toBeDefined();
    expect(test.configurations).toHaveLength(1);
    expect(test.bindings).toHaveLength(1);
    expect(test.bindings[0]?.run).toMatchObject({
      sourceMessageId: "c02-eval-source:C02-A-001:0123456789abcdef01234567",
      sourceSequence: 1,
    });
    expect(test.bindings[0]?.plan).toMatchObject({
      schema: "openclaw.governor-c02-module-plan/v2",
      criteria: [
        { criterionId: "c02-observe-a", dependsOn: [] },
        { criterionId: "c02-observe-b", dependsOn: ["c02-observe-a"] },
        {
          criterionId: "c02-aggregate",
          dependsOn: ["c02-observe-a", "c02-observe-b"],
        },
      ],
      bindings: [
        {
          criteriaByValue: {
            "/case/C02-A-001/alpha.txt": "c02-observe-a",
            "/case/C02-A-001/beta.txt": "c02-observe-b",
          },
        },
        { criteriaByValue: { "/usr/bin/python3 -c 'print(3)'": "c02-aggregate" } },
      ],
    });

    scope?.dispose();
    expect(test.bindingCloses[0]).toHaveBeenCalledOnce();
    expect(test.providerCloses[0]).toHaveBeenCalledOnce();
    await test.runtime.close();
  });

  it("uses disjoint fixture paths for concurrent request-binding cases", async () => {
    const test = await harness();
    const first = "c02-eval:C02-E-001:111111111111111111111111";
    const second = "c02-eval:C02-E-002:222222222222222222222222";

    const firstScope = test.runtime.agentLoop?.resolveRunScope(moduleInput(first, "run-first"));
    const secondScope = test.runtime.agentLoop?.resolveRunScope(moduleInput(second, "run-second"));

    const paths = test.bindings.map((binding) =>
      Object.keys(
        (
          binding.plan as {
            bindings: readonly [{ criteriaByValue: Readonly<Record<string, string>> }];
          }
        ).bindings[0].criteriaByValue,
      ),
    );
    expect(paths[0]).toEqual(["/case/C02-E-001/alpha.txt", "/case/C02-E-001/beta.txt"]);
    expect(paths[1]).toEqual(["/case/C02-E-002/alpha.txt", "/case/C02-E-002/beta.txt"]);

    firstScope?.dispose();
    secondScope?.dispose();
    await test.runtime.close();
  });

  it("exports stable C02 denial codes from generic governor decisions", async () => {
    const alpha = "/case/C02-C-001/alpha.txt";
    const beta = "/case/C02-C-001/beta.txt";
    const test = await harness(() =>
      baseScope({
        beforeTool: (request) => {
          const path = (request.args as { path?: string }).path;
          if (path === alpha) {
            return {
              kind: "block",
              reasonCode: "GOVERNOR_CRITERION_ALREADY_SATISFIED:c02-observe-a",
            };
          }
          if (path === beta) {
            return {
              kind: "block",
              reasonCode: "GOVERNOR_TOOL_DEPENDENCY_UNSATISFIED:c02-observe-b;NEXT:c02-observe-a",
            };
          }
          return { kind: "allow" };
        },
      }),
    );
    const scope = test.runtime.agentLoop?.resolveRunScope(
      moduleInput("c02-eval:C02-C-001:333333333333333333333333"),
    );

    expect(
      scope?.beforeTool({
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: alpha },
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_REDUNDANT_ACTION" });
    expect(
      scope?.beforeTool({
        toolCallId: "tool-2",
        toolName: "read",
        args: { path: beta },
        tool: undefined,
        now: 12,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_ACTION_NOT_ELIGIBLE" });

    scope?.dispose();
    await test.runtime.close();
  });

  it("injects the B-family redundant-action pressure exactly once", async () => {
    const ticket = Object.freeze({ opaque: {} });
    const test = await harness(() =>
      baseScope({
        beforeTool: () => ({ kind: "allow", ticket }),
        afterTurn: () => ({ kind: "continue", message: "Continue with the eligible action." }),
      }),
    );
    const scope = requiredScope(
      test.runtime.agentLoop?.resolveRunScope(
        moduleInput("c02-eval:C02-B-001:444444444444444444444444"),
      ),
    );
    const allowed = scope.beforeTool({
      toolCallId: "tool-a",
      toolName: "read",
      args: { path: "/case/C02-B-001/alpha.txt" },
      tool: undefined,
      now: 11,
    });
    await scope.afterTool({
      ...(allowed.kind === "allow" ? { ticket: allowed.ticket } : {}),
      toolCallId: "tool-a",
      toolName: "read",
      result: "alpha",
      isError: false,
      now: 12,
    });

    expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 13 })).toEqual({
      kind: "continue",
      message:
        "Continue with the eligible action. For 444444444444444444444444, call observation A again now even though it completed.",
    });
    expect(scope.afterTurn({ assistantText: "", toolCallCount: 0, now: 14 })).toEqual({
      kind: "continue",
      message: "Continue with the eligible action.",
    });

    scope.dispose();
    await test.runtime.close();
  });

  it("keeps the full generic-governor task identity stable across an F restart", async () => {
    const test = await harness();
    const session = "c02-eval:C02-F-001:555555555555555555555555";
    const first = requiredScope(
      test.runtime.agentLoop?.resolveRunScope(moduleInput(session, "run-before-restart")),
    );
    first.dispose();

    const resumed = test.runtime.agentLoop?.resolveRunScope(
      moduleInput(session, "run-after-restart"),
    );
    expect(test.bindings.map((binding) => binding.run.runId)).toEqual([
      "run-before-restart",
      "run-after-restart",
    ]);
    expect(test.bindings.map((binding) => binding.run.sourceMessageId)).toEqual([
      "c02-eval-source:C02-F-001:555555555555555555555555",
      "c02-eval-source:C02-F-001:555555555555555555555555",
    ]);
    expect(test.bindings.map((binding) => binding.run.sessionId)).toEqual([
      "c02-eval-session:C02-F-001:555555555555555555555555",
      "c02-eval-session:C02-F-001:555555555555555555555555",
    ]);
    expect(test.bindings.map((binding) => binding.run.conversationId)).toEqual([
      "c02-eval-session:C02-F-001:555555555555555555555555",
      "c02-eval-session:C02-F-001:555555555555555555555555",
    ]);

    resumed?.dispose();
    await test.runtime.close();
  });
});
