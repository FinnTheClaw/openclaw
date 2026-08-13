import { afterEach, describe, expect, it, vi } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
  governorAgentLoopTool as fakeTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveGovernorAgentLoopRunScope,
  type GovernorAgentLoopRunInput,
} from "./governor-agent-loop-readonly.js";
import {
  createGovernorHostRuntimeAdapterIfEnabled,
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostIntegrationConfiguration,
  type GovernorHostRuntime,
} from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "fixture.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function environment(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "security-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "security-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "security-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "security-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "security-ledger-key",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "security-deployment",
  };
}

function integrations(
  agentLoop: NonNullable<GovernorHostIntegrationConfiguration["agentLoop"]>,
): GovernorHostIntegrationConfiguration {
  return {
    evidenceOwnerId: "security-evidence-owner",
    approvalOwnerId: "security-approval-owner",
    deliveryOwnerId: "security-delivery-owner",
    ownerIngressOwnerId: "security-ingress-owner",
    childOwnerId: "security-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal",
        accountId: "security-owner-account",
        gatewayInstanceId: "security-owner-gateway",
        ownerPrincipal: "security-owner-principal",
        actions: ["repair"],
        scopeKeys: ["security-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
    agentLoop,
  };
}

function loopConfig(): NonNullable<GovernorHostIntegrationConfiguration["agentLoop"]> {
  return {
    mode: "enforce",
    scopes: [{ sessionKey: "security-session-key" }],
    criteria: [{ criterionId: "observed", description: "Observation exists" }],
    toolBindings: [
      {
        toolName: "observe",
        capability: capability.capability,
        canonicalTarget: "fixture:read",
        criterionId: "observed",
        implementationId: "disposable-observation-v1",
      },
    ],
    maxTurns: 3,
    expectedAssistantTextDigest: governorDigest("answer"),
  };
}

function runInput(overrides: Partial<GovernorAgentLoopRunInput> = {}): GovernorAgentLoopRunInput {
  return {
    runId: "security-run",
    sessionKey: "security-session-key",
    sessionId: "security-session",
    agentId: "security-agent",
    workspaceId: "security-workspace",
    channel: "security-channel",
    accountId: "security-account",
    principalId: "security-principal",
    conversationId: "security-conversation",
    sourceMessageId: "string-message-alpha",
    prompt: "Observe the fixture",
    now: 100,
    ...overrides,
  };
}

function startRuntime(stateDir: string, generation = 0): GovernorHostRuntime {
  return createGovernorHostRuntimeIfEnabled({
    env: environment(),
    stateDir,
    capabilities: [capability],
    integrations: {
      ...integrations(loopConfig()),
      deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation }],
    },
  })!;
}

afterEach(() => closeOpenClawStateDatabase());

describe("governed Agent loop trust and recovery boundaries", () => {
  it("allocates durable monotonic ingress for string IDs and rejects stale ordering", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-sequence-" },
      async (state) => {
        let runtime = startRuntime(state.stateDir);
        try {
          const first = resolveGovernorAgentLoopRunScope(runInput())!;
          expect(
            runtime.adapter.controller.store.loadTask(first.taskId as never)
              ?.authenticatedSourceSequence,
          ).toBe(1);
          first.dispose();

          const retry = resolveGovernorAgentLoopRunScope(runInput({ now: 110 }))!;
          expect(retry.taskId).toBe(first.taskId);
          expect(
            runtime.adapter.controller.store.loadTask(retry.taskId as never)
              ?.authenticatedSourceSequence,
          ).toBe(1);
          retry.dispose();

          const second = resolveGovernorAgentLoopRunScope(
            runInput({ sourceMessageId: "string-message-beta", now: 120 }),
          )!;
          expect(second.taskId).toBe(first.taskId);
          expect(
            runtime.adapter.controller.store.loadTask(second.taskId as never)
              ?.authenticatedSourceSequence,
          ).toBe(2);
          second.dispose();

          runtime.close();
          closeOpenClawStateDatabase();
          runtime = startRuntime(state.stateDir, 2);
          const third = resolveGovernorAgentLoopRunScope(
            runInput({ sourceMessageId: "string-message-gamma", now: 130 }),
          )!;
          expect(
            runtime.adapter.controller.store.loadTask(third.taskId as never)
              ?.authenticatedSourceSequence,
          ).toBe(3);
          third.dispose();
          expect(() =>
            resolveGovernorAgentLoopRunScope(
              runInput({ sourceMessageId: "string-message-stale", sourceSequence: 2, now: 140 }),
            ),
          ).toThrow("GOVERNOR_AGENT_LOOP_STALE_INGRESS");
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("rejects a same-name substituted tool before admission or execution", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-substitute-" },
      async (state) => {
        const runtime = startRuntime(state.stateDir);
        try {
          const scope = resolveGovernorAgentLoopRunScope(runInput())!;
          const substitutedExecute = vi.fn(async () => ({
            content: [{ type: "text" as const, text: "substituted" }],
            details: null,
          }));
          const substituted = fakeTool("observe", substitutedExecute);
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: [substituted] },
            streamFn: scriptedStream(() =>
              ++turn === 1
                ? assistant([
                    { type: "toolCall", id: "substituted-call", name: "observe", arguments: {} },
                  ])
                : assistant([{ type: "text", text: "answer" }]),
            ),
          });
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => 1_000 + turn });
          agent.state.tools = [substituted];
          await agent.prompt("attempt substitution");
          expect(() => bridge.assertTerminal()).toThrow("GOVERNOR_AGENT_LOOP_NO_PROGRESS");
          expect(substitutedExecute).toHaveBeenCalledTimes(0);
          expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(
            0,
          );
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });

  it.each([false, true])(
    "recovers a read-only effect after restart without duplicate durable outcome (executed=%s)",
    async (executedBeforeCrash) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "governor-loop-recovery-" },
        async (state) => {
          let runtime = startRuntime(state.stateDir);
          try {
            const input = runInput();
            const first = resolveGovernorAgentLoopRunScope(input)!;
            const firstTool = first.governedTools()[0]!;
            const firstDecision = first.beforeTool({
              toolCallId: "recovered-call",
              toolName: firstTool.name,
              args: { key: "restart" },
              tool: firstTool,
              now: 1_000,
            });
            expect(firstDecision.kind).toBe("allow");
            if (executedBeforeCrash) {
              await firstTool.execute("recovered-call", { key: "restart" });
            }
            runtime.close();
            closeOpenClawStateDatabase();

            runtime = startRuntime(state.stateDir, 2);
            const recovered = resolveGovernorAgentLoopRunScope(runInput({ now: 70_000 }))!;
            const recoveredTool = recovered.governedTools()[0]!;
            const recoveredDecision = recovered.beforeTool({
              toolCallId: "recovered-call",
              toolName: recoveredTool.name,
              args: { key: "restart" },
              tool: recoveredTool,
              now: 70_100,
            });
            expect(recoveredDecision.kind).toBe("allow");
            if (recoveredDecision.kind !== "allow") {
              throw new Error("fixture recovery was not allowed");
            }
            const result = await recoveredTool.execute("recovered-call", { key: "restart" });
            recovered.afterTool({
              ticket: recoveredDecision.ticket,
              toolCallId: "recovered-call",
              toolName: recoveredTool.name,
              result,
              isError: false,
              now: 70_101,
            });
            expect(
              runtime.adapter.controller.store.listEffects(recovered.taskId as never),
            ).toHaveLength(1);
            expect(
              runtime.adapter.controller.store.listEvidence(recovered.taskId as never),
            ).toHaveLength(1);
            recovered.dispose();
          } finally {
            runtime.close();
          }
        },
      );
    },
  );

  it.each(["override", "failure", "throw"] as const)(
    "records only the effective post-hook outcome (%s)",
    async (variant) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "governor-loop-post-hook-" },
        async (state) => {
          const runtime = startRuntime(state.stateDir);
          try {
            const scope = resolveGovernorAgentLoopRunScope(runInput())!;
            let turn = 0;
            const agent = new Agent({
              initialState: { model, tools: [] },
              afterToolCall: async () => {
                if (variant === "throw") {
                  throw new Error("fixture post-hook failure");
                }
                return {
                  content: [{ type: "text" as const, text: "post-hook-result" }],
                  details: null,
                  ...(variant === "failure" ? { isError: true } : {}),
                };
              },
              streamFn: scriptedStream(() =>
                ++turn === 1
                  ? assistant([
                      {
                        type: "toolCall",
                        id: `post-hook-${variant}`,
                        name: "observe",
                        arguments: {},
                      },
                    ])
                  : assistant([{ type: "text", text: "answer" }]),
              ),
            });
            const bridge = installGovernorLoopBridge({ agent, scope, now: () => 2_000 + turn });
            await agent.prompt("post-hook result");
            const effects = runtime.adapter.controller.store.listEffects(scope.taskId as never);
            expect(effects).toHaveLength(1);
            expect(effects[0]?.outcome.semantic).toBe(
              variant === "override" ? "success" : "transient_failure",
            );
            expect(
              runtime.adapter.controller.store.listEvidence(scope.taskId as never),
            ).toHaveLength(variant === "override" ? 1 : 0);
            if (variant === "override") {
              expect(effects[0]?.outcome.evidence).toMatchObject({
                resultDigest: governorDigest({
                  content: [{ type: "text", text: "post-hook-result" }],
                  details: null,
                }),
              });
              bridge.assertTerminal();
            }
            bridge.dispose();
          } finally {
            runtime.close();
          }
        },
      );
    },
  );

  it("durably records an interrupted in-flight read-only effect and replans", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-interrupt-" },
      async (state) => {
        const runtime = startRuntime(state.stateDir);
        try {
          const scope = resolveGovernorAgentLoopRunScope(runInput())!;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: scriptedStream(() => assistant([])),
          });
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => 3_000 });
          const tool = scope.governedTools()[0]!;
          expect(
            scope.beforeTool({
              toolCallId: "interrupted-call",
              toolName: tool.name,
              args: {},
              tool,
              now: 2_900,
            }).kind,
          ).toBe("allow");
          bridge.dispose();
          const effects = runtime.adapter.controller.store.listEffects(scope.taskId as never);
          expect(effects).toHaveLength(1);
          expect(effects[0]?.outcome).toMatchObject({
            transport: "unknown",
            semantic: "cancelled",
            sideEffect: "none",
            summaryCode: "runtime_interrupted",
          });
          expect(
            runtime.adapter.controller.store.actionIntents.listPendingIds(
              scope.taskId as never,
              effects[0]!.objectiveRevision,
            ),
          ).toEqual([]);
          expect(runtime.adapter.controller.store.loadTask(scope.taskId as never)?.state).toBe(
            "REPLAN_REQUIRED",
          );
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("durably replans an interrupted model turn with no active effect", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-model-interrupt-" },
      async (state) => {
        const runtime = startRuntime(state.stateDir);
        try {
          const scope = resolveGovernorAgentLoopRunScope(runInput())!;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: scriptedStream(() => assistant([])),
          });
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => 4_000 });
          bridge.dispose();
          expect(runtime.adapter.controller.store.loadTask(scope.taskId as never)?.state).toBe(
            "REPLAN_REQUIRED",
          );
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("rejects agent-loop activation through the adapter-only bootstrap", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-adapter-lifecycle-" },
      async (state) => {
        expect(() =>
          createGovernorHostRuntimeAdapterIfEnabled({
            env: environment(),
            stateDir: state.stateDir,
            capabilities: [capability],
            integrations: integrations(loopConfig()),
          }),
        ).toThrow("GOVERNOR_AGENT_LOOP_RUNTIME_LIFECYCLE_REQUIRED");
        expect(resolveGovernorAgentLoopRunScope(runInput())).toBeUndefined();
      },
    );
  });

  it("rejects mutating, child, and caller-selected implementation bindings before bootstrap", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-loop-closed-tools-" },
      async (state) => {
        const mutation: GovernorCapabilityDefinition = {
          ...capability,
          capability: "fixture.mutate",
          mutating: true,
          requiresApproval: true,
        };
        const configured = loopConfig();
        const withBinding = (binding: unknown) => ({
          ...configured,
          toolBindings: [binding],
        });
        const start = (agentLoop: unknown) =>
          createGovernorHostRuntimeIfEnabled({
            env: environment(),
            stateDir: state.stateDir,
            capabilities: [capability, mutation],
            integrations: integrations(agentLoop as never),
          });
        expect(() =>
          start(
            withBinding({
              ...configured.toolBindings[0],
              capability: mutation.capability,
            }),
          ),
        ).toThrow("GOVERNOR_AGENT_LOOP_READ_ONLY_CANARY_REQUIRED");
        expect(() =>
          start(withBinding({ ...configured.toolBindings[0], toolName: "sessions_spawn" })),
        ).toThrow("GOVERNOR_AGENT_LOOP_READ_ONLY_CANARY_REQUIRED");
        expect(() =>
          start(withBinding({ ...configured.toolBindings[0], implementationId: "caller-code" })),
        ).toThrow("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
      },
    );
  });
});
