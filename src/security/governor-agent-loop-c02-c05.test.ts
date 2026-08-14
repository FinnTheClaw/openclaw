import { afterEach, describe, expect, it } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
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
  capability: "c02-c05.observe",
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
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-c05-identity-key-0001",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-c05-evidence-key-0001",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-c05-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-c05-receipt-key-0001",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-c05-ledger-key-0001",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-c05-deployment-0001",
  };
}

function inputs(prompt: string) {
  return {
    runId: "c02-c05-run",
    sessionKey: "c02-c05-session",
    sessionId: "c02-c05-session-id",
    agentId: "c02-c05-agent",
    workspaceId: "c02-c05-workspace",
    channel: "c02-c05-channel",
    accountId: "c02-c05-account",
    principalId: "c02-c05-principal",
    conversationId: "c02-c05-conversation",
    sourceMessageId: `c02-c05-${prompt}`,
    sourceSequence: 1,
    prompt,
    now: 100,
  } as const;
}

function start(
  stateDir: string,
  criteria: readonly { criterionId: string; dependsOnCriteria?: readonly string[] }[],
) {
  return createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "c02-c05-evidence-owner",
      approvalOwnerId: "c02-c05-approval-owner",
      deliveryOwnerId: "c02-c05-delivery-owner",
      ownerIngressOwnerId: "c02-c05-ingress-owner",
      childOwnerId: "c02-c05-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-c05-owner-account",
          gatewayInstanceId: "c02-c05-owner-gateway",
          ownerPrincipal: "c02-c05-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-c05-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "c02-c05-session" }],
        criteria: criteria.map((item) => ({
          criterionId: item.criterionId,
          description: `Verify ${item.criterionId}`,
          ...(item.dependsOnCriteria ? { dependsOnCriteria: item.dependsOnCriteria } : {}),
        })),
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: Object.fromEntries(
              criteria
                .filter((item) => item.criterionId !== "aggregate")
                .map((item) => [item.criterionId, item.criterionId]),
            ),
            implementationId: "disposable-observation-v1",
          },
          ...(criteria.some((item) => item.criterionId === "aggregate")
            ? [
                {
                  toolName: "aggregate",
                  capability: capability.capability,
                  canonicalTarget: "fixture:aggregate",
                  criterionId: "aggregate",
                  implementationId: "disposable-aggregate-v1" as const,
                },
              ]
            : []),
        ],
        maxTurns: 12,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  })!;
}

afterEach(() => closeOpenClawStateDatabase());

describe("C02/C05 governor continuation", () => {
  it("executes three complete actions, then exposes one final-answer-only turn", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c02-final-" },
      async (state) => {
        const runtime = start(state.stateDir, [
          { criterionId: "alpha" },
          { criterionId: "beta" },
          { criterionId: "aggregate", dependsOnCriteria: ["alpha", "beta"] },
        ]);
        try {
          const scope = resolveGovernorAgentLoopRunScope(inputs("simple"))!;
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: scriptedStream(() => {
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
              if (turn === 3) {
                return assistant([
                  { type: "toolCall", id: "aggregate", name: "aggregate", arguments: {} },
                ]);
              }
              return assistant([{ type: "text", text: "done" }]);
            }),
          });
          const bridge = installGovernorLoopBridge({ agent, scope, now: () => turn + 1 });
          await agent.prompt("simple");
          bridge.assertTerminal();
          expect(turn).toBe(4);
          expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(
            3,
          );
          expect(runtime.adapter.controller.store.listEvidence(scope.taskId as never)).toHaveLength(
            3,
          );
          expect(agent.state.tools).toEqual([]);
          bridge.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("advances plan version before one retryable transient failure", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c05-plan-" },
      async (state) => {
        const runtime = start(state.stateDir, [{ criterionId: "alpha" }]);
        try {
          const scope = resolveGovernorAgentLoopRunScope(inputs("retry"))!;
          const tool = scope.governedTools()[0];
          const failed = scope.beforeTool({
            toolCallId: "failed-alpha",
            toolName: "observe",
            args: { key: "alpha" },
            tool,
            now: 101,
          });
          expect(failed.kind).toBe("allow");
          if (failed.kind !== "allow" || !failed.ticket) {
            throw new Error("missing failure ticket");
          }
          scope.afterTool({
            ticket: failed.ticket,
            toolCallId: "failed-alpha",
            toolName: "observe",
            result: { content: [], details: null },
            isError: true,
            now: 102,
          });
          expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 })).toMatchObject({
            kind: "continue",
            phase: "actions",
          });
          const task = runtime.adapter.controller.store.loadTask(scope.taskId as never)!;
          expect(task.planVersion).toBe(2);
          expect(runtime.adapter.controller.store.listEvents(scope.taskId as never)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                eventType: "runtime_replan_requested",
                payload: expect.objectContaining({
                  reasonCode: "tool_semantic_failure",
                  fromPlanVersion: 1,
                  checkpointId: expect.any(String),
                }),
              }),
            ]),
          );
          const retry = scope.beforeTool({
            toolCallId: "retry-alpha",
            toolName: "observe",
            args: { key: "alpha" },
            tool: scope.governedTools()[0],
            now: 104,
          });
          expect(retry.kind).toBe("allow");
          if (retry.kind !== "allow" || !retry.ticket) {
            throw new Error("missing retry ticket");
          }
          scope.afterTool({
            ticket: retry.ticket,
            toolCallId: "retry-alpha",
            toolName: "observe",
            result: { content: [{ type: "text", text: "alpha" }], details: null },
            isError: false,
            now: 105,
          });
          expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 106 })).toMatchObject({
            kind: "continue",
            phase: "final_response",
          });
          scope.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });
});
