import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "c02-c05.atomic.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const openRuntimes: ReturnType<typeof createGovernorHostRuntimeIfEnabled>[] = [];

function env(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-c05-atomic-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-c05-atomic-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-c05-atomic-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-c05-atomic-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-c05-atomic-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-c05-atomic-deployment",
  };
}

function start(
  stateDir: string,
  criteria: readonly { criterionId: string }[],
): ReturnType<typeof createGovernorHostRuntimeIfEnabled> {
  const runtime = createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "c02-c05-atomic-evidence-owner",
      approvalOwnerId: "c02-c05-atomic-approval-owner",
      deliveryOwnerId: "c02-c05-atomic-delivery-owner",
      ownerIngressOwnerId: "c02-c05-atomic-ingress-owner",
      childOwnerId: "c02-c05-atomic-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-c05-atomic-owner-account",
          gatewayInstanceId: "c02-c05-atomic-owner-gateway",
          ownerPrincipal: "c02-c05-atomic-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-c05-atomic-owner-scope"],
        },
      ],
      deliveries: [{ implementationId: "synthetic", config: {}, generation: 0 }],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "c02-c05-atomic-session" }],
        criteria: criteria.map((item) => ({
          criterionId: item.criterionId,
          description: `Verify ${item.criterionId}`,
        })),
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
        maxTurns: 12,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  })!;
  openRuntimes.push(runtime);
  return runtime;
}

function inputs(prompt: string) {
  return {
    runId: "c02-c05-atomic-run",
    sessionKey: "c02-c05-atomic-session",
    sessionId: "c02-c05-atomic-session-id",
    agentId: "c02-c05-atomic-agent",
    workspaceId: "c02-c05-atomic-workspace",
    channel: "c02-c05-atomic-channel",
    accountId: "c02-c05-atomic-account",
    principalId: "c02-c05-atomic-principal",
    conversationId: "c02-c05-atomic-conversation",
    sourceMessageId: `c02-c05-atomic-${prompt}`,
    sourceSequence: 1,
    prompt,
    now: 100,
  } as const;
}

function runTool(
  scope: ReturnType<typeof resolveGovernorAgentLoopRunScope> & object,
  key: string,
  id: string,
  now: number,
  isError = false,
): void {
  const decision = scope.beforeTool({
    toolCallId: id,
    toolName: "observe",
    args: { key },
    tool: scope.governedTools()[0],
    now,
  });
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("atomic recovery ticket was not admitted");
  }
  scope.afterTool({
    ticket: decision.ticket,
    toolCallId: id,
    toolName: "observe",
    result: isError ? { content: [], details: null } : { content: [{ type: "text", text: key }] },
    isError,
    now: now + 1,
  });
}

afterEach(() => {
  for (const runtime of openRuntimes.splice(0).toReversed()) {
    runtime.close();
  }
  closeOpenClawStateDatabase();
});

describe("C02/C05 atomic recovery boundaries", () => {
  it.each(["before_plan_commit", "after_plan_commit"] as const)(
    "recovers a %s planning crash without creating plan N+2",
    async (boundary) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `governor-c05-planning-${boundary}-` },
        async (state) => {
          const first = start(state.stateDir, [{ criterionId: "alpha" }, { criterionId: "beta" }]);
          const scope = resolveGovernorAgentLoopRunScope(inputs(`planning-${boundary}`))!;
          runTool(scope, "alpha", "planning-alpha", 101);
          scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
          const controller = first.adapter.controller;
          const taskId = scope.taskId;
          controller.requestRuntimeReplan(taskId as never, 104, "semantic_stagnation");
          const planningTask = controller.store.loadTask(taskId as never)!;
          expect(planningTask.state).toBe("REPLAN_REQUIRED");
          const originalCommit = controller.store.commit.bind(controller.store);
          vi.spyOn(controller.store, "commit").mockImplementation((params) => {
            if (params.event.eventType === "plan_replaced") {
              if (boundary === "before_plan_commit") {
                throw new Error("planning boundary crash");
              }
              originalCommit(params);
              throw new Error("planning boundary crash");
            }
            return originalCommit(params);
          });
          expect(() =>
            controller.preparePlan({
              taskId: taskId as never,
              plan: planningTask.plan!,
              now: 105,
            }),
          ).toThrow("planning boundary crash");
          vi.restoreAllMocks();
          scope.dispose();
          first.close();
          closeOpenClawStateDatabase();

          const second = start(state.stateDir, [{ criterionId: "alpha" }, { criterionId: "beta" }]);
          const resumed = resolveGovernorAgentLoopRunScope(inputs(`planning-${boundary}`))!;
          const recovered = second.adapter.controller.store.loadTask(taskId as never)!;
          expect(recovered.planVersion).toBe(2);
          expect(
            second.adapter.controller.store
              .listEvents(taskId as never)
              .filter((event) => event.eventType === "plan_replaced")
              .map((event) => (event.payload as { planVersion: number }).planVersion)
              .toSorted((left, right) => left - right),
          ).toStrictEqual([1, 2]);
          const retryDecision = resumed.beforeTool({
            toolCallId: "planning-retry",
            toolName: "observe",
            args: { key: "beta" },
            tool: resumed.governedTools()[0],
            now: 106,
          });
          expect(retryDecision).toMatchObject({ kind: "allow" });
          resumed.dispose();
          second.close();
        },
      );
    },
  );

  it("invalidates carry-forward lineage after real plan replacement and restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c05-carry-forward-restart-" },
      async (state) => {
        const first = start(state.stateDir, [{ criterionId: "alpha" }, { criterionId: "beta" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("carry-forward-restart"))!;
        runTool(scope, "alpha", "carry-alpha", 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        runTool(scope, "beta", "carry-beta", 104, true);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 106 });
        const taskId = scope.taskId;
        const store = first.adapter.controller.store;
        const source = store
          .listAllEvidence(taskId as never)
          .find((item) => item.criterionId === "alpha" && item.planVersion === 1)!;
        const carried = store
          .listAllEvidence(taskId as never)
          .find((item) => item.sourceEvidenceId === source.evidenceId)!;
        expect(carried.planVersion).toBe(2);
        scope.dispose();
        first.close();
        closeOpenClawStateDatabase();

        const second = start(state.stateDir, [{ criterionId: "alpha" }, { criterionId: "beta" }]);
        const task = second.adapter.controller.store.loadTask(taskId as never)!;
        const receipt = second.owners.evidence.submitEvidenceInvalidation({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          objectiveRevision: task.objectiveRevision,
          planVersion: task.planVersion,
          evidenceId: source.evidenceId,
          evidenceDigest: source.evidenceDigest,
          reasonCode: "contradicted_by_newer_evidence",
          provenance: {
            kind: "newer_evidence",
            sourceEvidenceId: "carry-forward-correction",
            sourceEvidenceDigest: "f".repeat(64),
            sourceObservedAt: 200,
            sourceScopeKey: task.scopeKey,
            confidence: "high",
            authority: "authenticated_host",
          },
          observedAt: 201,
        });
        second.adapter.controller.invalidateEvidence({
          taskId: task.taskId,
          evidenceId: source.evidenceId,
          receiptId: receipt,
        });
        const records = second.adapter.controller.store.listAllEvidence(taskId as never);
        expect(
          records.find((item) => item.evidenceId === source.evidenceId)?.invalidatedAt,
        ).toBeDefined();
        expect(
          records.find((item) => item.evidenceId === carried.evidenceId)?.invalidatedAt,
        ).toBeDefined();
        second.close();
      },
    );
  });
});
