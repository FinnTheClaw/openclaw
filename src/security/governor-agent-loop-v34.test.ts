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
import { buildGovernorAgentLoopProgress } from "./governor-agent-loop-progress.js";
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

function start(stateDir: string, criteria: readonly string[], maxTurns = 12) {
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
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
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
          ).toBe(2);
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("keeps invalidated evidence eligible for justified revalidation", () => {
    const snapshot = buildGovernorAgentLoopProgress(
      {
        store: {
          loadTask: () => ({
            planVersion: 1,
            contract: { completionCriteria: [{ criterionId: "alpha", mandatory: true }] },
          }),
          listEvidence: () => [
            { criterionId: "alpha", admissibility: "admitted", invalidatedAt: 200 },
          ],
          listEffects: () => [],
        },
      } as never,
      "v34-task" as never,
      {
        criteria: [{ criterionId: "alpha", description: "Verify alpha" }],
        toolBindings: [{ toolName: "observe", criterionId: "alpha" }],
      } as never,
    );
    expect(snapshot.satisfiedCriteria).toEqual([]);
    expect(snapshot.remainingCriteria).toEqual(["alpha"]);
    expect(snapshot.nextActions[0]?.criterionId).toBe("alpha");
  });
});
