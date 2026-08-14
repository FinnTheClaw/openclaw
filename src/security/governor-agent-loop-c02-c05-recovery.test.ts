import { afterEach, describe, expect, it, vi } from "vitest";
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
import { applyGovernorTransition } from "../tasks/governor/state-machine.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "c02-c05.recovery.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const env = (): NodeJS.ProcessEnv => ({
  OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
  NODE_ENV: "test",
  OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-c05-recovery-identity-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-c05-recovery-evidence-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-c05-recovery-evidence-v1",
  OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-c05-recovery-receipt-key",
  OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-c05-recovery-ledger-key",
  OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-c05-recovery-deployment",
});

function inputs(prompt: string) {
  return {
    runId: "c02-c05-recovery-run",
    sessionKey: "c02-c05-recovery-session",
    sessionId: "c02-c05-recovery-session-id",
    agentId: "c02-c05-recovery-agent",
    workspaceId: "c02-c05-recovery-workspace",
    channel: "c02-c05-recovery-channel",
    accountId: "c02-c05-recovery-account",
    principalId: "c02-c05-recovery-principal",
    conversationId: "c02-c05-recovery-conversation",
    sourceMessageId: `c02-c05-recovery-${prompt}`,
    sourceSequence: 1,
    prompt,
    now: 100,
  } as const;
}

const openRuntimes: ReturnType<typeof createGovernorHostRuntimeIfEnabled>[] = [];

function start(
  stateDir: string,
  criteria: readonly { criterionId: string; dependsOnCriteria?: readonly string[] }[],
) {
  const runtime = createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "c02-c05-recovery-evidence-owner",
      approvalOwnerId: "c02-c05-recovery-approval-owner",
      deliveryOwnerId: "c02-c05-recovery-delivery-owner",
      ownerIngressOwnerId: "c02-c05-recovery-ingress-owner",
      childOwnerId: "c02-c05-recovery-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-c05-recovery-owner-account",
          gatewayInstanceId: "c02-c05-recovery-owner-gateway",
          ownerPrincipal: "c02-c05-recovery-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-c05-recovery-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "c02-c05-recovery-session" }],
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
  now: number,
): void {
  const decision = scope.beforeTool({
    toolCallId: "observe-alpha",
    toolName: "observe",
    args: { key: "alpha" },
    tool: scope.governedTools().find((item) => item.name === "observe"),
    now,
  });
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("missing recovery ticket");
  }
  scope.afterTool({
    ticket: decision.ticket,
    toolCallId: "observe-alpha",
    toolName: "observe",
    result: { content: [{ type: "text", text: "alpha" }], details: null },
    isError: false,
    now: now + 1,
  });
}

function persistFinishCandidate(
  controller: ReturnType<typeof start>["adapter"]["controller"],
  taskId: string,
  now: number,
): void {
  let current = controller.store.loadTask(taskId as never)!;
  if (current.state === "EXECUTING") {
    current = controller.beginVerification(taskId as never, now);
  }
  const transition = applyGovernorTransition({
    task: current,
    expectedTaskVersion: current.taskVersion,
    expectedLeaseEpoch: current.leaseEpoch,
    to: "FINISH_CANDIDATE",
    now,
  });
  if (!transition.applied) {
    throw new Error("test failed to persist finish candidate");
  }
  const event = createGovernorEventRecord({
    task: transition.task,
    eventType: "runtime_finish_proposed",
    payload: {
      phase: "final_response",
      finalResponsePending: true,
      planVersion: transition.task.planVersion,
      progressDigest: transition.task.finalResponsePhase?.progressDigest ?? "",
    },
    now: now + 1,
  });
  expect(controller.store.commit({ current, next: transition.task, event })).toMatchObject({
    applied: true,
  });
}

function assertNoAgentTools(agent: { state: { tools: readonly unknown[] } }): void {
  expect(agent.state.tools).toHaveLength(0);
}

function assertSimulatedCrash(action: () => unknown): void {
  expect(action).toThrow(/simulated/u);
}

async function runFinishCandidateRecovery(
  failureBoundary: "verification" | "candidate" | "decision" | "terminal_commit",
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: `governor-c02-${failureBoundary}-` },
    async (state) => {
      const first = start(state.stateDir, [{ criterionId: "alpha" }]);
      const scope = resolveGovernorAgentLoopRunScope(inputs(`c02-${failureBoundary}`))!;
      runTool(scope, 101);
      scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
      const taskId = scope.taskId;
      if (failureBoundary === "verification") {
        first.adapter.controller.beginVerification(taskId as never, 104);
      } else {
        persistFinishCandidate(first.adapter.controller, taskId, 104);
      }
      scope.dispose();
      first.close();
      closeOpenClawStateDatabase();

      const second = start(state.stateDir, [{ criterionId: "alpha" }]);
      const resumed = resolveGovernorAgentLoopRunScope(inputs(`c02-${failureBoundary}`))!;
      expect(resumed.turnPhase()).toBe("final_response");
      const agent = new Agent({
        initialState: { model, tools: [...resumed.governedTools()] },
        streamFn: scriptedStream(() => assistant([{ type: "text", text: "done" }])),
      });
      const bridge = installGovernorLoopBridge({ agent, scope: resumed, now: () => 200 });
      assertNoAgentTools(agent);
      if (failureBoundary === "decision") {
        vi.spyOn(second.adapter.controller.store, "listCurrentEffects").mockImplementationOnce(
          () => {
            throw new Error("simulated decision crash");
          },
        );
      } else if (failureBoundary === "terminal_commit") {
        vi.spyOn(second.adapter.controller.store, "commit").mockImplementationOnce(() => {
          throw new Error("simulated terminal commit crash");
        });
      }
      if (failureBoundary === "decision" || failureBoundary === "terminal_commit") {
        assertSimulatedCrash(() =>
          resumed.afterTurn({ assistantText: "done", toolCallCount: 0, now: 105 }),
        );
        bridge.dispose();
        resumed.dispose();
        second.close();
        closeOpenClawStateDatabase();
      }
      const third =
        failureBoundary === "candidate" || failureBoundary === "verification"
          ? second
          : start(state.stateDir, [{ criterionId: "alpha" }]);
      const retry =
        failureBoundary === "candidate" || failureBoundary === "verification"
          ? resumed
          : resolveGovernorAgentLoopRunScope(inputs(`c02-${failureBoundary}`))!;
      expect(retry.turnPhase()).toBe("final_response");
      expect(retry.afterTurn({ assistantText: "done", toolCallCount: 0, now: 106 })).toMatchObject({
        kind: "complete",
      });
      expect(third.adapter.controller.store.loadTask(taskId as never)?.state).toBe("COMPLETED");
      if (failureBoundary === "candidate" || failureBoundary === "verification") {
        bridge.dispose();
      }
      retry.dispose();
      third.close();
    },
  );
}

afterEach(() => {
  for (const runtime of openRuntimes.splice(0).toReversed()) {
    runtime?.close();
  }
  closeOpenClawStateDatabase();
});

describe("C02/C05 restart recovery boundaries", () => {
  it.each(["verification", "candidate", "decision", "terminal_commit"] as const)(
    "recovers a masked finish candidate after %s failure",
    async (failureBoundary) =>
      await expect(runFinishCandidateRecovery(failureBoundary)).resolves.toBeUndefined(),
  );

  it("durably replans when recovered finish evidence is no longer current", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c02-recovery-invalidated-" },
      async (state) => {
        const runtime = start(state.stateDir, [{ criterionId: "alpha" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("recovery-invalidated"))!;
        runTool(scope, 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        const store = runtime.adapter.controller.store;
        const task = store.loadTask(scope.taskId as never)!;
        const source = store.listAllEvidence(scope.taskId as never)[0]!;
        persistFinishCandidate(runtime.adapter.controller, task.taskId, 104);
        const candidateTask = store.loadTask(task.taskId)!;
        const receipt = runtime.owners.evidence.submitEvidenceInvalidation({
          scopeKey: candidateTask.scopeKey,
          taskId: candidateTask.taskId,
          taskVersion: candidateTask.taskVersion,
          objectiveRevision: candidateTask.objectiveRevision,
          planVersion: candidateTask.planVersion,
          evidenceId: source.evidenceId,
          evidenceDigest: source.evidenceDigest,
          reasonCode: "contradicted_by_newer_evidence",
          provenance: {
            kind: "newer_evidence",
            sourceEvidenceId: "recovery-correction",
            sourceEvidenceDigest: "d".repeat(64),
            sourceObservedAt: 200,
            sourceScopeKey: candidateTask.scopeKey,
            confidence: "high",
            authority: "authenticated_host",
          },
          observedAt: 201,
        });
        runtime.adapter.controller.invalidateEvidence({
          taskId: task.taskId,
          evidenceId: source.evidenceId,
          receiptId: receipt,
        });
        expect(
          scope.afterTurn({ assistantText: "done", toolCallCount: 0, now: 205 }),
        ).toMatchObject({
          kind: "continue",
          phase: "actions",
        });
        expect(store.loadTask(task.taskId)?.state).toBe("REPLAN_REQUIRED");
        expect(store.loadTask(task.taskId)?.finalResponsePhase).toBeUndefined();
        expect(scope.turnPhase()).toBe("actions");
        scope.dispose();
        runtime.close();
      },
    );
  });

  it("durably replans when recovered finish response validation fails", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c02-recovery-response-" },
      async (state) => {
        const runtime = start(state.stateDir, [{ criterionId: "alpha" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("recovery-response"))!;
        runTool(scope, 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        const task = runtime.adapter.controller.store.loadTask(scope.taskId as never)!;
        persistFinishCandidate(runtime.adapter.controller, task.taskId, 104);
        expect(
          scope.afterTurn({ assistantText: "wrong", toolCallCount: 0, now: 105 }),
        ).toMatchObject({
          kind: "continue",
          phase: "actions",
        });
        expect(runtime.adapter.controller.store.loadTask(task.taskId)?.state).toBe(
          "REPLAN_REQUIRED",
        );
        expect(
          runtime.adapter.controller.store.loadTask(task.taskId)?.finalResponsePhase,
        ).toBeUndefined();
        expect(scope.turnPhase()).toBe("actions");
        scope.dispose();
        runtime.close();
      },
    );
  });

  it("rejects carry-forward whose source was invalidated before the write transaction", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-c05-invalidation-race-" },
      async (state) => {
        const runtime = start(state.stateDir, [{ criterionId: "alpha" }]);
        const scope = resolveGovernorAgentLoopRunScope(inputs("invalidation-race"))!;
        runTool(scope, 101);
        scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 });
        const store = runtime.adapter.controller.store;
        const task = store.loadTask(scope.taskId as never)!;
        const source = store.listAllEvidence(scope.taskId as never)[0]!;
        const pending = store.carryForwardEvidence({
          source,
          task: { ...task, planVersion: task.planVersion + 1, taskVersion: task.taskVersion + 1 },
          now: 104,
        });
        const receipt = runtime.owners.evidence.submitEvidenceInvalidation({
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
            sourceEvidenceId: "race-correction",
            sourceEvidenceDigest: "c".repeat(64),
            sourceObservedAt: 200,
            sourceScopeKey: task.scopeKey,
            confidence: "high",
            authority: "authenticated_host",
          },
          observedAt: 201,
        });
        runtime.adapter.controller.invalidateEvidence({
          taskId: task.taskId,
          evidenceId: source.evidenceId,
          receiptId: receipt,
        });
        const current = store.loadTask(task.taskId)!;
        const next = {
          ...current,
          planVersion: current.planVersion + 1,
          taskVersion: current.taskVersion + 1,
        };
        expect(() =>
          store.commit({
            current,
            next,
            event: createGovernorEventRecord({
              task: next,
              eventType: "plan_replaced",
              payload: { planVersion: next.planVersion },
              now: 202,
            }),
            evidenceAdmissions: [pending],
          }),
        ).toThrow("GOVERNOR_EVIDENCE_SOURCE_INVALIDATED");
        expect(store.listAllEvidence(task.taskId)).not.toContainEqual(
          expect.objectContaining({ evidenceId: pending.evidence.evidenceId }),
        );
        scope.dispose();
        runtime.close();
      },
    );
  });
});
