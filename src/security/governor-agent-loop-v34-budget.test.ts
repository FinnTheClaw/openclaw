import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "v34.budget.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const env = (): NodeJS.ProcessEnv => ({
  OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
  NODE_ENV: "test",
  OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "v34-budget-identity",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "v34-budget-evidence",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "v34-budget-evidence-v1",
  OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "v34-budget-receipt",
  OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "v34-budget-ledger",
  OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "v34-budget-deployment",
});

function start(stateDir: string, maxTurns: number) {
  return createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "v34-budget-evidence-owner",
      approvalOwnerId: "v34-budget-approval-owner",
      deliveryOwnerId: "v34-budget-delivery-owner",
      ownerIngressOwnerId: "v34-budget-ingress-owner",
      childOwnerId: "v34-budget-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "v34-budget-account",
          gatewayInstanceId: "v34-budget-gateway",
          ownerPrincipal: "v34-budget-owner",
          actions: ["repair"],
          scopeKeys: ["v34-budget-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "v34-budget-session" }],
        criteria: [{ criterionId: "alpha", description: "Verify alpha" }],
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: { alpha: "alpha" },
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
    runId: "v34-budget-run",
    sessionKey: "v34-budget-session",
    sessionId: "v34-budget-session-id",
    agentId: "v34-budget-agent",
    workspaceId: "v34-budget-workspace",
    channel: "fixture",
    accountId: "v34-budget-account",
    principalId: "v34-budget-principal",
    conversationId: "v34-budget-conversation",
    sourceMessageId: "v34-budget-source",
    sourceSequence: 1,
    prompt: "budget",
    now: 100,
  } as const;
}

afterEach(() => closeOpenClawStateDatabase());

describe("V34 durable model-turn budget", () => {
  it("reconstructs the absolute model-turn budget across restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-budget-restart-" },
      async (state) => {
        const runtime = start(state.stateDir, 2);
        const scope = resolveGovernorAgentLoopRunScope(input())!;
        expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 101 }).kind).toBe(
          "continue",
        );
        scope.dispose();
        runtime.close();
        closeOpenClawStateDatabase();
        const restarted = start(state.stateDir, 1);
        expect(() => resolveGovernorAgentLoopRunScope(input())).toThrow(
          "GOVERNOR_AGENT_LOOP_BUDGET_EXHAUSTED",
        );
        restarted.close();
      },
    );
  });
});
