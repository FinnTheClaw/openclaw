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
import { createGovernorEventRecord } from "../tasks/governor/events.js";
import { assertGovernorEvidenceLineage } from "../tasks/governor/store-evidence-lineage.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "c02-c05.restart.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const env = (): NodeJS.ProcessEnv => ({
  OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
  NODE_ENV: "test",
  OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-c05-restart-identity-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-c05-restart-evidence-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-c05-restart-evidence-v1",
  OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-c05-restart-receipt-key",
  OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-c05-restart-ledger-key",
  OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-c05-restart-deployment",
});

function inputs(prompt: string) {
  return {
    runId: "c02-c05-restart-run",
    sessionKey: "c02-c05-restart-session",
    sessionId: "c02-c05-restart-session-id",
    agentId: "c02-c05-restart-agent",
    workspaceId: "c02-c05-restart-workspace",
    channel: "c02-c05-restart-channel",
    accountId: "c02-c05-restart-account",
    principalId: "c02-c05-restart-principal",
    conversationId: "c02-c05-restart-conversation",
    sourceMessageId: `c02-c05-restart-${prompt}`,
    sourceSequence: 1,
    prompt,
    now: 100,
  } as const;
}

function start(
  stateDir: string,
  criteria: readonly { criterionId: string; dependsOnCriteria?: readonly string[] }[],
) {
  const runtime = createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "c02-c05-restart-evidence-owner",
      approvalOwnerId: "c02-c05-restart-approval-owner",
      deliveryOwnerId: "c02-c05-restart-delivery-owner",
      ownerIngressOwnerId: "c02-c05-restart-ingress-owner",
      childOwnerId: "c02-c05-restart-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-c05-restart-owner-account",
          gatewayInstanceId: "c02-c05-restart-owner-gateway",
          ownerPrincipal: "c02-c05-restart-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-c05-restart-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "c02-c05-restart-session" }],
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
  openRuntimes.push(runtime);
  return runtime;
}

function runTool(
  scope: ReturnType<typeof resolveGovernorAgentLoopRunScope> & object,
  toolName: string,
  key: string,
  id: string,
  now: number,
  error = false,
) {
  const decision = scope.beforeTool({
    toolCallId: id,
    toolName,
    args: toolName === "observe" ? { key } : {},
    tool: scope.governedTools().find((item) => item.name === toolName),
    now,
  });
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error(`missing ticket ${id}`);
  }
  scope.afterTool({
    ticket: decision.ticket,
    toolCallId: id,
    toolName,
    result: error
      ? { content: [], details: null }
      : { content: [{ type: "text", text: key }], details: null },
    isError: error,
    now: now + 1,
  });
}

const openRuntimes: ReturnType<typeof createGovernorHostRuntimeIfEnabled>[] = [];

afterEach(() => {
  for (const runtime of openRuntimes.splice(0).toReversed()) {
    runtime?.close();
  }
  closeOpenClawStateDatabase();
});

describe("C02/C05 durable restart boundaries", () => {
  it("keeps final-response masking through pending, VERIFYING, and completed restart boundaries", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c02-boundaries-" },
      async (state) => {
        const criteria = [
          { criterionId: "alpha" },
          { criterionId: "beta" },
          { criterionId: "aggregate", dependsOnCriteria: ["alpha", "beta"] },
        ] as const;
        const first = start(state.stateDir, criteria);
        const scope = resolveGovernorAgentLoopRunScope(inputs("phase"))!;
        runTool(scope, "observe", "alpha", "alpha", 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        runTool(scope, "observe", "beta", "beta", 104);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 106 });
        runTool(scope, "aggregate", "aggregate", "aggregate", 107);
        expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 109 })).toMatchObject({
          phase: "final_response",
        });
        const taskId = scope.taskId;
        const effects = first.adapter.controller.store.listEffects(taskId as never).length;
        scope.dispose();
        first.close();
        closeOpenClawStateDatabase();

        const second = start(state.stateDir, criteria);
        const resumed = resolveGovernorAgentLoopRunScope(inputs("phase"))!;
        const agent = new Agent({
          initialState: { model, tools: [...resumed.governedTools()] },
          streamFn: scriptedStream(() => assistant([{ type: "text", text: "done" }])),
        });
        const bridge = installGovernorLoopBridge({ agent, scope: resumed, now: () => 200 });
        expect(resumed.turnPhase()).toBe("final_response");
        expect(agent.state.tools).toStrictEqual([]);
        expect(second.adapter.controller.store.listEffects(taskId as never)).toHaveLength(effects);
        second.adapter.controller.beginVerification(taskId as never, 201);
        bridge.dispose();
        second.close();
        closeOpenClawStateDatabase();

        const third = start(state.stateDir, criteria);
        const verifying = resolveGovernorAgentLoopRunScope(inputs("phase"))!;
        const verifyingAgent = new Agent({
          initialState: { model, tools: [...verifying.governedTools()] },
          streamFn: scriptedStream(() => assistant([{ type: "text", text: "done" }])),
        });
        const verifyingBridge = installGovernorLoopBridge({
          agent: verifyingAgent,
          scope: verifying,
          now: () => 300,
        });
        expect(verifying.turnPhase()).toBe("final_response");
        expect(verifyingAgent.state.tools).toStrictEqual([]);
        const finished = third.adapter.controller.proposeFinish({
          taskId: taskId as never,
          response: { framing: "none", materialClaimIds: [] },
          now: 301,
        });
        expect(finished).toMatchObject({ completed: true });
        verifyingBridge.dispose();
        third.close();
        closeOpenClawStateDatabase();

        const fourth = start(state.stateDir, criteria);
        expect(fourth.adapter.controller.store.loadTask(taskId as never)?.state).toBe("COMPLETED");
        expect(fourth.adapter.controller.store.listEffects(taskId as never)).toHaveLength(effects);
        fourth.close();
      },
    );
  });

  it("records immutable carry-forward lineage and invalidates every descendant transactionally", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c05-lineage-" },
      async (state) => {
        const runtime = start(state.stateDir, [{ criterionId: "alpha" }, { criterionId: "beta" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("lineage"))!;
        runTool(scope, "observe", "alpha", "alpha", 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        runTool(scope, "observe", "beta", "beta-failed", 104, true);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 106 });
        const store = runtime.adapter.controller.store;
        const task = store.loadTask(scope.taskId as never)!;
        const all = store.listAllEvidence(scope.taskId as never);
        const source = all
          .filter((item) => item.criterionId === "alpha")
          .find((item) => item.planVersion === 1)!;
        const firstDescendant = all.find((item) => item.sourceEvidenceId === source.evidenceId)!;
        const nextTask = {
          ...task,
          planVersion: task.planVersion + 1,
          taskVersion: task.taskVersion + 1,
        };
        const secondDescendant = store.carryForwardEvidence({
          source: firstDescendant,
          task: nextTask,
          now: 110,
        });
        const committed = store.commit({
          current: task,
          next: nextTask,
          event: createGovernorEventRecord({
            task: nextTask,
            eventType: "plan_replaced",
            payload: {
              planVersion: nextTask.planVersion,
              planDigest: governorDigest(nextTask.plan as never),
            },
            now: 111,
          }),
          evidenceAdmissions: [secondDescendant],
        });
        expect(committed).toMatchObject({ applied: true });
        const current = store.loadTask(scope.taskId as never)!;
        const receipt = runtime.owners.evidence.submitEvidenceInvalidation({
          scopeKey: current.scopeKey,
          taskId: current.taskId,
          taskVersion: current.taskVersion,
          objectiveRevision: current.objectiveRevision,
          planVersion: current.planVersion,
          evidenceId: source.evidenceId,
          evidenceDigest: source.evidenceDigest,
          reasonCode: "contradicted_by_newer_evidence",
          provenance: {
            kind: "newer_evidence",
            sourceEvidenceId: "lineage-correction",
            sourceEvidenceDigest: "a".repeat(64),
            sourceObservedAt: 200,
            sourceScopeKey: current.scopeKey,
            confidence: "high",
            authority: "authenticated_host",
          },
          observedAt: 201,
        });
        runtime.adapter.controller.invalidateEvidence({
          taskId: current.taskId,
          evidenceId: source.evidenceId,
          receiptId: receipt,
        });
        const invalidatedEvidence = store.listAllEvidence(scope.taskId as never);
        const descendantIds = [
          source.evidenceId,
          firstDescendant.evidenceId,
          secondDescendant.evidence.evidenceId,
        ];
        expect(
          descendantIds.map(
            (evidenceId) =>
              invalidatedEvidence.find((item) => item.evidenceId === evidenceId)?.invalidatedAt,
          ),
        ).not.toContain(undefined);
        expect(() =>
          assertGovernorEvidenceLineage({
            source,
            task: { ...current, taskId: "other" as never },
            records: all,
          }),
        ).toThrow(/TASK_MISMATCH/u);
        const cycleSource = { ...source, sourceEvidenceId: secondDescendant.evidence.evidenceId };
        const cycleChild = {
          ...secondDescendant.evidence,
          sourceEvidenceId: cycleSource.evidenceId,
        };
        expect(() =>
          assertGovernorEvidenceLineage({
            source: cycleSource,
            task: current,
            records: [cycleSource, cycleChild],
          }),
        ).toThrow(/LINEAGE_/u);
        scope.dispose();
        runtime.close();
      },
    );
  });

  it("restarts from a plan transition without advancing beyond one replacement", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c05-restart-" },
      async (state) => {
        const first = start(state.stateDir, [{ criterionId: "alpha" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("plan-restart"))!;
        runTool(scope, "observe", "alpha", "failed", 101, true);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        const taskId = scope.taskId;
        expect(first.adapter.controller.store.loadTask(taskId as never)?.planVersion).toBe(2);
        const planEventsBeforeRestart = first.adapter.controller.store
          .listEvents(taskId as never)
          .filter((event) => event.eventType === "plan_replaced");
        expect(
          planEventsBeforeRestart.map(
            (event) => (event.payload as unknown as { planVersion: number }).planVersion,
          ),
        ).toStrictEqual([1, 2]);
        scope.dispose();
        first.close();
        closeOpenClawStateDatabase();
        const second = start(state.stateDir, [{ criterionId: "alpha" }]);
        const resumed = resolveGovernorAgentLoopRunScope(inputs("plan-restart"))!;
        const task = second.adapter.controller.store.loadTask(taskId as never)!;
        expect(task.planVersion).toBe(2);
        const planEventsAfterRestart = second.adapter.controller.store
          .listEvents(taskId as never)
          .filter((event) => event.eventType === "plan_replaced");
        expect(planEventsAfterRestart).toHaveLength(planEventsBeforeRestart.length);
        expect(
          planEventsAfterRestart.map(
            (event) => (event.payload as unknown as { planVersion: number }).planVersion,
          ),
        ).toStrictEqual([1, 2]);
        expect(
          resumed.beforeTool({
            toolCallId: "retry",
            toolName: "observe",
            args: { key: "alpha" },
            tool: resumed.governedTools()[0],
            now: 104,
          }).kind,
        ).toBe("allow");
        resumed.dispose();
        second.close();
      },
    );
  });
});
