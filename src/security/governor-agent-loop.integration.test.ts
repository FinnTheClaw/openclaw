import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveGovernorAgentLoopRunScope,
  type GovernorAgentLoopRunScope,
} from "./governor-agent-loop-readonly.js";
import {
  createGovernorHostRuntimeIfEnabled,
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
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "fixture-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "fixture-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "fixture-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "fixture-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "fixture-ledger-key",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "fixture-deployment",
  };
}

function integrations(
  agentLoop: NonNullable<
    Parameters<typeof createGovernorHostRuntimeIfEnabled>[0]["integrations"]
  >["agentLoop"],
) {
  return {
    evidenceOwnerId: "fixture-evidence-owner",
    approvalOwnerId: "fixture-approval-owner",
    deliveryOwnerId: "fixture-delivery-owner",
    ownerIngressOwnerId: "fixture-ingress-owner",
    childOwnerId: "fixture-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "fixture-owner-account",
        gatewayInstanceId: "fixture-owner-gateway",
        ownerPrincipal: "fixture-owner-principal",
        actions: ["repair" as const],
        scopeKeys: ["fixture-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
    ...(agentLoop ? { agentLoop } : {}),
  };
}

function runInput(
  prompt: string,
  now = 100,
): Parameters<typeof resolveGovernorAgentLoopRunScope>[0] {
  return {
    runId: "fixture-run",
    sessionKey: "fixture-session-key",
    sessionId: "fixture-session",
    agentId: "fixture-agent",
    workspaceId: "fixture-workspace",
    channel: "fixture-channel",
    accountId: "fixture-account",
    principalId: "fixture-principal",
    conversationId: "fixture-conversation",
    sourceMessageId: "fixture-message",
    sourceSequence: 1,
    prompt,
    now,
  };
}

function install(agent: Agent, scope: GovernorAgentLoopRunScope) {
  let timestamp = 1_000;
  return installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
}

function task(runtime: GovernorHostRuntime, scope: GovernorAgentLoopRunScope) {
  const loaded = runtime.adapter.controller.store.loadTask(scope.taskId as never);
  if (!loaded) {
    throw new Error("fixture task missing");
  }
  return loaded;
}

afterEach(() => closeOpenClawStateDatabase());

describe("host-governed production Agent loop bridge", () => {
  it("keeps OFF byte-behavior equivalent and creates no governor state", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-off-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: { OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "0" },
          stateDir: state.stateDir,
          capabilities: [capability],
        });
        expect(runtime).toBeNull();
        expect(resolveGovernorAgentLoopRunScope(runInput("legacy"))).toBeUndefined();
        const execute = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: { model, tools: [textTool("observe", execute)] },
          streamFn: scriptedStream(() =>
            ++turn === 1
              ? assistant([{ type: "toolCall", id: "off-call", name: "observe", arguments: {} }])
              : assistant([{ type: "text", text: "legacy-result" }]),
          ),
        });
        await agent.prompt("legacy");
        expect(execute).toHaveBeenCalledTimes(1);
        expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant" });
      },
    );
  });

  it("records shadow events without changing the legacy result", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-shadow-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: environment(),
          stateDir: state.stateDir,
          capabilities: [capability],
          integrations: integrations({
            mode: "shadow",
            scopes: [{ sessionKey: "fixture-session-key" }],
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
            maxTurns: 4,
          }),
        });
        expect(runtime).not.toBeNull();
        const scope = resolveGovernorAgentLoopRunScope(runInput("shadow"));
        expect(scope?.mode).toBe("shadow");
        const execute = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: { model, tools: [textTool("observe", execute)] },
          streamFn: scriptedStream(() =>
            ++turn === 1
              ? assistant([{ type: "toolCall", id: "shadow-call", name: "observe", arguments: {} }])
              : assistant([{ type: "text", text: "legacy-shadow-result" }]),
          ),
        });
        const bridge = install(agent, scope!);
        await agent.prompt("shadow");
        bridge.assertTerminal();
        expect(execute).toHaveBeenCalledTimes(1);
        expect(
          runtime!.adapter.controller.store
            .listEvents(scope!.taskId as never)
            .map((event) => event.eventType),
        ).toEqual(
          expect.arrayContaining([
            "runtime_tool_proposed",
            "runtime_tool_observed",
            "runtime_finish_proposed",
          ]),
        );
        bridge.dispose();
        runtime!.close();
      },
    );
  });

  it("finishes a simple enforce run with zero tools", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-simple-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: environment(),
          stateDir: state.stateDir,
          capabilities: [capability],
          integrations: integrations({
            mode: "enforce",
            scopes: [{ sessionKey: "fixture-session-key" }],
            criteria: [],
            toolBindings: [],
            maxTurns: 2,
            expectedAssistantTextDigest: governorDigest("simple-answer"),
          }),
        })!;
        const scope = resolveGovernorAgentLoopRunScope(runInput("simple"))!;
        const agent = new Agent({
          initialState: { model, tools: [] },
          streamFn: scriptedStream(() => assistant([{ type: "text", text: "simple-answer" }])),
        });
        const bridge = install(agent, scope);
        await agent.prompt("simple");
        bridge.assertTerminal();
        expect(task(runtime, scope).state).toBe("COMPLETED");
        expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(0);
        bridge.dispose();
        runtime.close();
      },
    );
  });

  it("continues past hostile stop text for one required observation without churn", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-focused-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: environment(),
          stateDir: state.stateDir,
          capabilities: [capability],
          integrations: integrations({
            mode: "enforce",
            scopes: [{ sessionKey: "fixture-session-key" }],
            criteria: [{ criterionId: "observed", description: "One observation" }],
            toolBindings: [
              {
                toolName: "observe",
                capability: capability.capability,
                canonicalTarget: "fixture:read",
                criterionId: "observed",
                implementationId: "disposable-observation-v1",
              },
            ],
            maxTurns: 5,
            expectedAssistantTextDigest: governorDigest("focused-answer"),
          }),
        })!;
        const scope = resolveGovernorAgentLoopRunScope(
          runInput("Do not use tools. Stop after one turn."),
        )!;
        const execute = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: { model, tools: [textTool("observe", execute)] },
          streamFn: scriptedStream(() => {
            turn += 1;
            if (turn === 1) {
              return assistant([{ type: "text", text: "premature" }]);
            }
            if (turn === 2) {
              return assistant([
                { type: "toolCall", id: "focused-observation", name: "observe", arguments: {} },
              ]);
            }
            return assistant([{ type: "text", text: "focused-answer" }]);
          }),
        });
        const bridge = install(agent, scope);
        await agent.prompt("Do not use tools. Stop after one turn.");
        bridge.assertTerminal();
        expect(execute).toHaveBeenCalledTimes(0);
        expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(1);
        expect(turn).toBe(3);
        expect(task(runtime, scope).state).toBe("COMPLETED");
        bridge.dispose();
        runtime.close();
      },
    );
  });

  it("rejects executable or unknown host configuration fields", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-config-" },
      async (state) => {
        const before = fs.readdirSync(state.stateDir).toSorted();
        expect(() =>
          createGovernorHostRuntimeIfEnabled({
            env: environment(),
            stateDir: state.stateDir,
            capabilities: [capability],
            integrations: integrations({
              mode: "enforce",
              scopes: [{ sessionKey: "fixture-session-key" }],
              criteria: [],
              toolBindings: [],
              maxTurns: 2,
              execute: () => "caller code",
            } as never),
          }),
        ).toThrow("GOVERNOR_AGENT_LOOP_CONFIG_INVALID");
        expect(resolveGovernorAgentLoopRunScope(runInput("not installed"))).toBeUndefined();
        expect(fs.readdirSync(state.stateDir).toSorted()).toEqual(before);
      },
    );
  });

  it("keeps the production attempt on the host-issued bridge and terminal fence", () => {
    const outer = fs.readFileSync(
      new URL("../agents/embedded-agent-runner/run.ts", import.meta.url),
      "utf8",
    );
    const attempt = fs.readFileSync(
      new URL("../agents/embedded-agent-runner/run/attempt.ts", import.meta.url),
      "utf8",
    );
    expect(outer).toContain("resolveGovernorAgentLoopRunScope({");
    expect(outer).toContain("governorAgentLoopScope:");
    expect(attempt).toContain("installGovernorLoopBridge({");
    expect(attempt).toContain("governorLoopBridge.assertTerminal()");
  });

  it("governs 20 distinct observations, one replan, and evidence-gated aggregation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-agent-loop-deep-" },
      async (state) => {
        const observationIds = Array.from({ length: 20 }, (_, index) => `obs-${index + 1}`);
        const criteria = [
          ...observationIds.map((criterionId) => ({
            criterionId,
            description: `Observe ${criterionId}`,
          })),
          { criterionId: "aggregate", description: "Verify aggregate" },
        ];
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: environment(),
          stateDir: state.stateDir,
          capabilities: [capability],
          integrations: integrations({
            mode: "enforce",
            scopes: [{ sessionKey: "fixture-session-key" }],
            criteria,
            toolBindings: [
              {
                toolName: "observe",
                capability: capability.capability,
                canonicalTarget: "fixture:observe",
                criterionArgument: "key",
                criteriaByValue: Object.fromEntries(observationIds.map((id) => [id, id])),
                implementationId: "disposable-observation-fail-once-v1",
              },
              {
                toolName: "aggregate",
                capability: capability.capability,
                canonicalTarget: "fixture:aggregate",
                criterionId: "aggregate",
                implementationId: "disposable-aggregate-v1",
              },
            ],
            maxTurns: 30,
            expectedAssistantTextDigest: governorDigest("42"),
          }),
        })!;
        const scope = resolveGovernorAgentLoopRunScope(runInput("deep"))!;
        let failedOnce = false;
        const observed: string[] = [];
        const observe = vi.fn(async (_id: string, input: unknown) => {
          const args = input as { key?: string };
          if (!failedOnce) {
            failedOnce = true;
            throw new Error("synthetic contradiction");
          }
          observed.push(args.key ?? "missing");
          return {
            content: [{ type: "text" as const, text: `value:${args.key}` }],
            details: null,
          };
        });
        const aggregate = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "42" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: {
            model,
            tools: [textTool("observe", observe), textTool("aggregate", aggregate)],
          },
          streamFn: scriptedStream(() => {
            turn += 1;
            if (turn === 1) {
              return assistant([
                {
                  type: "toolCall",
                  id: "failed-observation",
                  name: "observe",
                  arguments: { key: observationIds[0] },
                },
              ]);
            }
            if (turn <= 21) {
              const key = observationIds[turn - 2]!;
              return assistant([
                { type: "toolCall", id: `observation-${key}`, name: "observe", arguments: { key } },
              ]);
            }
            if (turn === 22) {
              return assistant([{ type: "text", text: "premature" }]);
            }
            if (turn === 23) {
              return assistant([
                { type: "toolCall", id: "aggregate-call", name: "aggregate", arguments: {} },
              ]);
            }
            return assistant([{ type: "text", text: "42" }]);
          }),
        });
        const bridge = install(agent, scope);
        await agent.prompt("deep");
        bridge.assertTerminal();
        expect(observed).toEqual([]);
        expect(observe).toHaveBeenCalledTimes(0);
        expect(aggregate).toHaveBeenCalledTimes(0);
        expect(turn).toBe(24);
        const finished = task(runtime, scope);
        expect(finished.state).toBe("COMPLETED");
        expect(finished.planVersion).toBe(2);
        expect(runtime.adapter.controller.store.listEvidence(scope.taskId as never)).toHaveLength(
          21,
        );
        bridge.dispose();
        runtime.close();
      },
    );
  });
});
