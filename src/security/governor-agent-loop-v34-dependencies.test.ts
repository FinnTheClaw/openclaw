import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { buildGovernorAgentLoopProgress } from "./governor-agent-loop-progress.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "v34.dependency-observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const criteria = [
  { criterionId: "alpha", description: "alpha" },
  { criterionId: "beta", description: "beta" },
  {
    criterionId: "derived",
    description: "derived",
    dependsOnCriteria: ["alpha"],
  },
  {
    criterionId: "aggregate",
    description: "aggregate",
    dependsOnCriteria: ["derived", "beta"],
  },
] as const;

function env(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "v34-dependency-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "v34-dependency-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "v34-dependency-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "v34-dependency-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "v34-dependency-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "v34-dependency-deployment",
  };
}

function start(stateDir: string) {
  const agentLoop: GovernorAgentLoopConfiguration = {
    mode: "enforce" as const,
    scopes: [{ sessionKey: "v34-dependency-session" }],
    criteria,
    toolBindings: [
      {
        toolName: "observe",
        capability: capability.capability,
        canonicalTarget: "fixture:observe",
        criterionArgument: "key",
        criteriaByValue: Object.fromEntries(
          criteria.map((item) => [item.criterionId, item.criterionId]),
        ),
        implementationId: "disposable-observation-v1",
      },
    ],
    maxTurns: 20,
    expectedAssistantTextDigest: governorDigest("done"),
  };
  const runtime = createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "v34-dependency-evidence-owner",
      approvalOwnerId: "v34-dependency-approval-owner",
      deliveryOwnerId: "v34-dependency-delivery-owner",
      ownerIngressOwnerId: "v34-dependency-ingress-owner",
      childOwnerId: "v34-dependency-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "v34-dependency-owner-account",
          gatewayInstanceId: "v34-dependency-owner-gateway",
          ownerPrincipal: "v34-dependency-owner-principal",
          actions: ["repair"],
          scopeKeys: ["v34-dependency-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop,
    },
  })!;
  return { runtime, agentLoop };
}

function input() {
  return {
    runId: "v34-dependency-run",
    sessionKey: "v34-dependency-session",
    sessionId: "v34-dependency-session-id",
    agentId: "v34-dependency-agent",
    workspaceId: "v34-dependency-workspace",
    channel: "v34-dependency-channel",
    accountId: "v34-dependency-account",
    principalId: "v34-dependency-principal",
    conversationId: "v34-dependency-conversation",
    sourceMessageId: "v34-dependency-message",
    sourceSequence: 1,
    prompt: "complete the dependency fixture",
    now: 100,
  } as const;
}

afterEach(() => closeOpenClawStateDatabase());

describe("V34 host-owned criterion dependencies", () => {
  it("keeps independent work eligible and transitively fences derived evidence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-dependencies-" },
      async (state) => {
        const { runtime, agentLoop } = start(state.stateDir);
        try {
          const scope = resolveGovernorAgentLoopRunScope(input())!;
          const tool = scope.governedTools()[0];
          const execute = (key: string, id: string, now: number) => {
            const decision = scope.beforeTool({
              toolCallId: id,
              toolName: "observe",
              args: { key },
              tool,
              now,
            });
            expect(decision.kind).toBe("allow");
            if (decision.kind !== "allow" || !decision.ticket) {
              throw new Error("missing ticket");
            }
            scope.afterTool({
              ticket: decision.ticket,
              toolCallId: id,
              toolName: "observe",
              result: { key, value: `value-${key}` },
              isError: false,
              now: now + 1,
            });
          };
          const initial = buildGovernorAgentLoopProgress(
            runtime.adapter.controller,
            scope.taskId as never,
            agentLoop,
          );
          expect(initial.nextActions.map((action) => action.criterionId)).toEqual([
            "alpha",
            "beta",
          ]);
          expect(
            scope.beforeTool({
              toolCallId: "aggregate-too-early",
              toolName: "observe",
              args: { key: "aggregate" },
              tool,
              now: 101,
            }),
          ).toMatchObject({ kind: "block" });

          execute("alpha", "alpha-1", 110);
          expect(
            scope.beforeTool({
              toolCallId: "aggregate-after-alpha",
              toolName: "observe",
              args: { key: "aggregate" },
              tool,
              now: 120,
            }),
          ).toMatchObject({ kind: "block" });
          execute("beta", "beta-1", 130);
          execute("derived", "derived-1", 140);
          execute("aggregate", "aggregate-1", 150);

          const alpha = runtime.adapter.controller.store
            .listEvidence(scope.taskId as never)
            .find((record) => record.criterionId === "alpha");
          const task = runtime.adapter.controller.store.loadTask(scope.taskId as never)!;
          const receipt = runtime.owners.evidence.submitEvidenceInvalidation({
            scopeKey: task.scopeKey,
            taskId: task.taskId,
            taskVersion: task.taskVersion,
            objectiveRevision: task.objectiveRevision,
            planVersion: task.planVersion,
            evidenceId: alpha!.evidenceId,
            evidenceDigest: alpha!.evidenceDigest,
            reasonCode: "contradicted_by_newer_evidence",
            provenance: {
              kind: "newer_evidence",
              sourceEvidenceId: "host-observation-alpha-new",
              sourceEvidenceDigest: "a".repeat(64),
              sourceObservedAt: 250,
              sourceScopeKey: task.scopeKey,
              confidence: "high",
              authority: "authenticated_host",
            },
            observedAt: 300,
          });
          runtime.adapter.controller.invalidateEvidence({
            taskId: task.taskId,
            evidenceId: alpha!.evidenceId,
            receiptId: receipt,
          });
          const invalidatedProgress = buildGovernorAgentLoopProgress(
            runtime.adapter.controller,
            scope.taskId as never,
            agentLoop,
          );
          expect(invalidatedProgress.satisfiedCriteria).not.toContain("derived");
          expect(invalidatedProgress.satisfiedCriteria).not.toContain("aggregate");
          execute("alpha", "alpha-2", 310);
          expect(
            scope.beforeTool({
              toolCallId: "aggregate-after-alpha-reobserve",
              toolName: "observe",
              args: { key: "aggregate" },
              tool,
              now: 320,
            }),
          ).toMatchObject({ kind: "block" });
          const finalProgress = buildGovernorAgentLoopProgress(
            runtime.adapter.controller,
            scope.taskId as never,
            agentLoop,
          );
          expect(finalProgress.satisfiedCriteria).toContain("beta");
          expect(finalProgress.satisfiedCriteria).not.toContain("aggregate");
          expect(
            runtime.adapter.controller.store
              .listEvidence(scope.taskId as never)
              .filter((record) => record.invalidatedAt !== undefined),
          ).toHaveLength(3);
          scope.dispose();
          runtime.close();
          closeOpenClawStateDatabase();
          const replayRuntime = start(state.stateDir);
          const beforeReplayEvents = replayRuntime.runtime.adapter.controller.store.listEvents(
            scope.taskId as never,
          );
          const replayed = replayRuntime.runtime.adapter.controller.invalidateEvidence({
            taskId: scope.taskId as never,
            evidenceId: alpha!.evidenceId,
            receiptId: receipt,
          });
          expect(replayed.evidenceId).toBe(alpha!.evidenceId);
          expect(
            replayRuntime.runtime.adapter.controller.store.listEvents(scope.taskId as never),
          ).toEqual(beforeReplayEvents);
          replayRuntime.runtime.close();
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("does not re-guide a handled failure after success, progress, and restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-guidance-chain-" },
      async (state) => {
        const firstRuntime = start(state.stateDir);
        const firstScope = resolveGovernorAgentLoopRunScope(input())!;
        const tool = firstScope.governedTools()[0];
        const failed = firstScope.beforeTool({
          toolCallId: "alpha-failed",
          toolName: "observe",
          args: { key: "alpha" },
          tool,
          now: 101,
        });
        expect(failed.kind).toBe("allow");
        if (failed.kind !== "allow" || !failed.ticket) {
          throw new Error("missing first ticket");
        }
        firstScope.afterTool({
          ticket: failed.ticket,
          toolCallId: "alpha-failed",
          toolName: "observe",
          result: { content: [], details: null },
          isError: true,
          now: 102,
        });
        expect(
          firstScope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 }),
        ).toMatchObject({
          kind: "continue",
        });
        const firstGuidance = firstRuntime.runtime.adapter.controller.store
          .listEvents(firstScope.taskId as never)
          .filter((event) => event.eventType === "runtime_replan_requested");
        expect(firstGuidance).toHaveLength(1);

        const retry = firstScope.beforeTool({
          toolCallId: "alpha-success",
          toolName: "observe",
          args: { key: "alpha" },
          tool,
          now: 104,
        });
        expect(retry.kind).toBe("allow");
        if (retry.kind !== "allow" || !retry.ticket) {
          throw new Error("missing retry ticket");
        }
        firstScope.afterTool({
          ticket: retry.ticket,
          toolCallId: "alpha-success",
          toolName: "observe",
          result: { content: [{ type: "text", text: "alpha" }], details: null },
          isError: false,
          now: 105,
        });
        expect(
          firstScope.afterTurn({ assistantText: "", toolCallCount: 1, now: 106 }),
        ).toMatchObject({
          kind: "continue",
        });
        const firstEffectId = firstGuidance[0]?.payload;
        firstScope.dispose();
        firstRuntime.runtime.close();
        closeOpenClawStateDatabase();

        const restarted = start(state.stateDir);
        const recovered = resolveGovernorAgentLoopRunScope(input())!;
        const betaFailure = recovered.beforeTool({
          toolCallId: "beta-failed",
          toolName: "observe",
          args: { key: "beta" },
          tool: recovered.governedTools()[0],
          now: 201,
        });
        expect(betaFailure.kind).toBe("allow");
        if (betaFailure.kind !== "allow" || !betaFailure.ticket) {
          throw new Error("missing new failure ticket");
        }
        recovered.afterTool({
          ticket: betaFailure.ticket,
          toolCallId: "beta-failed",
          toolName: "observe",
          result: { content: [], details: null },
          isError: true,
          now: 202,
        });
        expect(
          recovered.afterTurn({ assistantText: "", toolCallCount: 1, now: 203 }),
        ).toMatchObject({
          kind: "continue",
        });
        const guidance = restarted.runtime.adapter.controller.store
          .listEvents(recovered.taskId as never)
          .filter((event) => event.eventType === "runtime_replan_requested");
        expect(guidance).toHaveLength(2);
        expect(guidance.map((event) => event.payload)).toEqual(
          expect.arrayContaining([expect.objectContaining({ sourceEffectId: expect.any(String) })]),
        );
        expect(guidance[0]?.payload).toEqual(firstEffectId);
        recovered.dispose();
        restarted.runtime.close();
      },
    );
  });

  it("rejects reason/provenance mismatches at the host receipt boundary", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-invalidation-provenance-" },
      async (state) => {
        const { runtime } = start(state.stateDir);
        expect(() =>
          runtime.owners.evidence.submitEvidenceInvalidation({
            scopeKey: "scope-a",
            taskId: "task-a",
            taskVersion: 1,
            objectiveRevision: 1,
            planVersion: 1,
            evidenceId: "evidence-a",
            evidenceDigest: "a".repeat(64),
            reasonCode: "contradicted_by_newer_evidence",
            provenance: {
              kind: "newer_evidence",
              sourceEvidenceId: "evidence-b",
              sourceEvidenceDigest: "b".repeat(64),
              sourceObservedAt: 2,
              sourceScopeKey: "scope-b",
              confidence: "high",
              authority: "authenticated_host",
            },
            observedAt: 3,
          }),
        ).toThrow("Governor evidence invalidation provenance is invalid");
        runtime.close();
      },
    );
  });
});
