import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type StreamFn,
} from "../../packages/agent-core/src/llm.js";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";
const capability: GovernorCapabilityDefinition = {
  capability: "v34.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function env(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "v34-identity-key-0001",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "v34-evidence-key-0001",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "v34-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "v34-receipt-key-0001",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "v34-ledger-key-0001",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "v34-deployment-0001",
  };
}
function start(stateDir: string, criteria: readonly string[], maxTurns = 12, generation = 0) {
  return createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "v34-evidence-owner",
      approvalOwnerId: "v34-approval-owner",
      deliveryOwnerId: "v34-delivery-owner",
      ownerIngressOwnerId: "v34-ingress-owner",
      childOwnerId: "v34-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "v34-owner-account",
          gatewayInstanceId: "v34-owner-gateway",
          ownerPrincipal: "v34-owner-principal",
          actions: ["repair"],
          scopeKeys: ["v34-owner-scope"],
        },
      ],
      deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation }],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "v34-session" }],
        criteria: criteria.map((criterionId) => ({
          criterionId,
          description: `Verify ${criterionId}`,
        })),
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: Object.fromEntries(criteria.map((id) => [id, id])),
            implementationId: "disposable-observation-v1",
          },
        ],
        maxTurns,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  })!;
}
function input() {
  return {
    runId: "v34-run",
    sessionKey: "v34-session",
    sessionId: "v34-session-id",
    agentId: "v34-agent",
    workspaceId: "v34-workspace",
    channel: "v34-channel",
    accountId: "v34-account",
    principalId: "v34-principal",
    conversationId: "v34-conversation",
    sourceMessageId: "v34-message",
    sourceSequence: 1,
    prompt: "complete the fixture",
    now: 100,
  } as const;
}
function streamFor(next: () => ReturnType<typeof assistant>, seen?: string[][]): StreamFn {
  return (_model, context) => {
    seen?.push(
      context.messages
        .filter((message) => message.role === "user")
        .flatMap((message) => {
          if (typeof message.content === "string") {
            return [message.content];
          }
          return message.content
            .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
            .map((item) => item.text);
        }),
    );
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = next();
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };
}
afterEach(() => closeOpenClawStateDatabase());

describe("V34 governed continuation", () => {
  it("steers evidence-derived progress before the next model response", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-steer-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha"]);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          const seen: string[][] = [];
          let turn = 0;
          const agent = new Agent({
            initialState: {
              model,
              tools: [textTool("observe", async () => ({ content: [], details: null }))],
            },
            streamFn: streamFor(() => {
              turn += 1;
              return turn === 1
                ? assistant([
                    {
                      type: "toolCall",
                      id: "observe-alpha",
                      name: "observe",
                      arguments: { key: "alpha" },
                    },
                  ])
                : assistant([{ type: "text", text: "done" }]);
            }, seen),
          });
          let timestamp = 0;
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
          await agent.prompt("complete the fixture");
          bridge.assertTerminal();
          expect(seen[1]?.some((text) => text.includes("Host progress (verified)"))).toBe(true);
          expect(seen[1]?.some((text) => text.includes("satisfied=[alpha]"))).toBe(true);
          expect(agent.state.tools.find((tool) => tool.name === "observe")?.description).toContain(
            "Verify alpha",
          );
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
  it("moves from two satisfied observations to the next eligible action without rereads", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-progress-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha", "beta"], 12);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: streamFor(() => {
              turn += 1;
              if (turn === 1) {
                return assistant([
                  { type: "toolCall", id: "alpha", name: "observe", arguments: { key: "alpha" } },
                ]);
              }
              if (turn === 2) {
                return assistant([
                  { type: "toolCall", id: "beta", name: "observe", arguments: { key: "beta" } },
                ]);
              }
              return assistant([{ type: "text", text: "done" }]);
            }),
          });
          let timestamp = 0;
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
          await agent.prompt("complete the fixture");
          bridge.assertTerminal();
          expect(runtime.adapter.controller.store.listEvidence(scope.taskId as never)).toHaveLength(
            2,
          );
          expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(
            2,
          );
          expect(turn).toBe(3);
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
  it("replans once and then fails closed on repeated semantic stagnation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-stagnation-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha"], 12);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: streamFor(() => {
              turn += 1;
              return assistant([
                {
                  type: "toolCall",
                  id: `repeat-${turn}`,
                  name: "observe",
                  arguments: { key: "alpha" },
                },
              ]);
            }),
          });
          let timestamp = 0;
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
          await agent.prompt("repeat the fixture");
          expect(() => bridge.assertTerminal()).toThrow("GOVERNOR_AGENT_LOOP_NO_PROGRESS");
          expect(turn).toBe(3);
          expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(
            1,
          );
          expect(
            runtime.adapter.controller.store.loadTask(scope.taskId as never)?.planVersion,
          ).toBe(1);
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
  it("allows justified revalidation through the signed invalidation API", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-revalidate-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha"]);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: streamFor(() => {
              turn += 1;
              if (turn === 2) {
                const evidence = runtime.adapter.controller.store.listEvidence(
                  scope.taskId as never,
                )[0];
                const task = runtime.adapter.controller.store.loadTask(scope.taskId as never)!;
                const receipt = runtime.owners.evidence.submitEvidenceInvalidation({
                  scopeKey: task.scopeKey,
                  taskId: scope.taskId as never,
                  taskVersion: task.taskVersion,
                  objectiveRevision: task.objectiveRevision,
                  planVersion: task.planVersion,
                  evidenceId: evidence!.evidenceId,
                  evidenceDigest: evidence!.evidenceDigest,
                  reasonCode: "contradicted_by_newer_evidence",
                  provenance: {
                    kind: "newer_evidence",
                    sourceEvidenceId: "host-observation-alpha-new",
                    sourceEvidenceDigest: "a".repeat(64),
                    sourceObservedAt: 150,
                    sourceScopeKey: task.scopeKey,
                    confidence: "high",
                    authority: "authenticated_host",
                  },
                  observedAt: 200,
                });
                runtime.adapter.controller.invalidateEvidence({
                  taskId: scope.taskId as never,
                  evidenceId: evidence!.evidenceId,
                  receiptId: receipt,
                });
              }
              if (turn <= 2) {
                return assistant([
                  {
                    type: "toolCall",
                    id: `revalidate-${turn}`,
                    name: "observe",
                    arguments: { key: "alpha" },
                  },
                ]);
              }
              return assistant([{ type: "text", text: "done" }]);
            }),
          });
          let timestamp = 0;
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
          await agent.prompt("revalidate the fixture");
          bridge.assertTerminal();
          expect(turn).toBe(3);
          const evidence = runtime.adapter.controller.store.listEvidence(scope.taskId as never);
          expect(evidence).toHaveLength(2);
          expect(
            runtime.adapter.controller.store
              .listEvents(scope.taskId as never)
              .find((event) => event.eventType === "evidence_invalidated")?.payload,
          ).toMatchObject({ reasonCode: "contradicted_by_newer_evidence" });
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
  it("rejects missing and unknown criterion arguments before physical execution", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-arguments-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha", "beta"]);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: streamFor(() => assistant([{ type: "text", text: "done" }])),
          });
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => 1 });
          const tool = agent.state.tools.find((item) => item.name === "observe");
          const missing = scope.beforeTool({
            toolCallId: "missing",
            toolName: "observe",
            args: {},
            tool,
            now: 1,
          });
          const unknown = scope.beforeTool({
            toolCallId: "unknown",
            toolName: "observe",
            args: { key: "gamma" },
            tool,
            now: 1,
          });
          expect(missing).toMatchObject({ kind: "block" });
          expect(unknown).toMatchObject({ kind: "block" });
          expect(JSON.stringify(missing)).toContain("ALLOWED:alpha,beta");
          expect(JSON.stringify(unknown)).toContain("ALLOWED:alpha,beta");
          expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toEqual([]);
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
  it("replaces pending owned steering and permits reissue after delivery", async () => {
    const seen: string[][] = [];
    let turn = 0;
    const agent = new Agent({
      initialState: { model, tools: [] },
      streamFn: streamFor(() => {
        turn += 1;
        return assistant([{ type: "text", text: `turn-${turn}` }]);
      }, seen),
    });
    agent.steer({
      role: "user",
      content: [{ type: "text", text: "unrelated steering" }],
      timestamp: 1,
    });
    agent.steerKeyed("governor", {
      role: "user",
      content: [{ type: "text", text: "progress A" }],
      timestamp: 2,
    });
    agent.steerKeyed("governor", {
      role: "user",
      content: [{ type: "text", text: "progress B" }],
      timestamp: 3,
    });
    await agent.prompt("start");
    expect(seen.flat()).toContain("unrelated steering");
    expect(seen.flat()).toContain("progress B");
    expect(seen.flat()).not.toContain("progress A");

    agent.steerKeyed("governor", {
      role: "user",
      content: [{ type: "text", text: "progress B" }],
      timestamp: 4,
    });
    await agent.continue();
    expect(seen.flat()).toContain("progress B");
    expect(turn).toBe(3);
  });

  it("reconstructs one durable tool-error replan after a restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-replan-restart-" },
      async (state) => {
        const runtime = start(state.stateDir, ["alpha"]);
        const scope = resolveGovernorAgentLoopRunScope(input())!;
        const tool = scope.governedTools()[0];
        const first = scope.beforeTool({
          toolCallId: "failed-first",
          toolName: "observe",
          args: { key: "alpha" },
          tool,
          now: 101,
        });
        expect(first.kind).toBe("allow");
        if (first.kind !== "allow" || !first.ticket) {
          throw new Error("fixture ticket missing");
        }
        scope.afterTool({
          ticket: first.ticket,
          toolCallId: "failed-first",
          toolName: "observe",
          result: { content: [], details: null },
          isError: true,
          now: 102,
        });
        scope.dispose();
        runtime.close();
        closeOpenClawStateDatabase();

        const restarted = start(state.stateDir, ["alpha"], 12, 2);
        const recovered = resolveGovernorAgentLoopRunScope(input())!;
        const guidance = restarted.adapter.controller.store
          .listEvents(recovered.taskId as never)
          .filter((event) => event.eventType === "runtime_replan_requested");
        expect(guidance).toHaveLength(1);
        expect(guidance[0]?.payload).toMatchObject({
          guidanceOnly: true,
          reasonCode: "tool_semantic_failure",
        });

        const retry = recovered.beforeTool({
          toolCallId: "failed-retry",
          toolName: "observe",
          args: { key: "alpha" },
          tool: recovered.governedTools()[0],
          now: 201,
        });
        expect(retry.kind).toBe("allow");
        if (retry.kind !== "allow" || !retry.ticket) {
          throw new Error("fixture retry ticket missing");
        }
        recovered.afterTool({
          ticket: retry.ticket,
          toolCallId: "failed-retry",
          toolName: "observe",
          result: { content: [], details: null },
          isError: true,
          now: 202,
        });
        expect(recovered.afterTurn({ assistantText: "", toolCallCount: 1, now: 203 })).toEqual({
          kind: "stop",
          reasonCode: "GOVERNOR_AGENT_LOOP_NO_PROGRESS",
        });
        expect(
          restarted.adapter.controller.store
            .listEvents(recovered.taskId as never)
            .filter((event) => event.eventType === "runtime_replan_requested"),
        ).toHaveLength(1);
        recovered.dispose();
        restarted.close();
      },
    );
  });
});
