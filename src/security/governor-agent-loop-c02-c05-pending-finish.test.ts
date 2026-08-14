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

type Phase = "normal" | "verifying" | "candidate";
type Cause = "digest" | "evidence";
type Crash = "before_rejection" | "after_rejection";

const capability: GovernorCapabilityDefinition = {
  capability: "c02-c05.pending.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const openRuntimes: ReturnType<typeof createGovernorHostRuntimeIfEnabled>[] = [];

function capture(action: () => unknown): { result?: unknown; error?: unknown } {
  try {
    return { result: action() };
  } catch (error) {
    return { error };
  }
}

function closeOwnedRuntime(runtime: ReturnType<typeof start>): void {
  const index = openRuntimes.lastIndexOf(runtime);
  if (index >= 0) {
    openRuntimes.splice(index, 1);
  }
  runtime.close();
}

function env(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-c05-pending-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-c05-pending-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-c05-pending-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-c05-pending-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-c05-pending-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-c05-pending-deployment",
  };
}

function input(id: string) {
  return {
    runId: "c02-c05-pending-run",
    sessionKey: "c02-c05-pending-session",
    sessionId: "c02-c05-pending-session-id",
    agentId: "c02-c05-pending-agent",
    workspaceId: "c02-c05-pending-workspace",
    channel: "c02-c05-pending-channel",
    accountId: "c02-c05-pending-account",
    principalId: "c02-c05-pending-principal",
    conversationId: "c02-c05-pending-conversation",
    sourceMessageId: `c02-c05-pending-${id}`,
    sourceSequence: 1,
    prompt: id,
    now: 100,
  } as const;
}

function start(stateDir: string) {
  const runtime = createGovernorHostRuntimeIfEnabled({
    env: env(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "c02-c05-pending-evidence-owner",
      approvalOwnerId: "c02-c05-pending-approval-owner",
      deliveryOwnerId: "c02-c05-pending-delivery-owner",
      ownerIngressOwnerId: "c02-c05-pending-ingress-owner",
      childOwnerId: "c02-c05-pending-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-c05-pending-owner-account",
          gatewayInstanceId: "c02-c05-pending-owner-gateway",
          ownerPrincipal: "c02-c05-pending-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-c05-pending-owner-scope"],
        },
      ],
      deliveries: [{ implementationId: "synthetic", config: {}, generation: 0 }],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "c02-c05-pending-session" }],
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
        maxTurns: 12,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  })!;
  openRuntimes.push(runtime);
  return runtime;
}

function observe(scope: ReturnType<typeof resolveGovernorAgentLoopRunScope> & object, now: number) {
  const decision = scope.beforeTool({
    toolCallId: "pending-alpha",
    toolName: "observe",
    args: { key: "alpha" },
    tool: scope.governedTools().find((tool) => tool.name === "observe"),
    now,
  });
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("missing pending-finish ticket");
  }
  scope.afterTool({
    ticket: decision.ticket,
    toolCallId: "pending-alpha",
    toolName: "observe",
    result: { content: [{ type: "text", text: "alpha" }], details: null },
    isError: false,
    now: now + 1,
  });
}

function persistCandidate(runtime: ReturnType<typeof start>, taskId: string, now: number): void {
  const current = runtime.adapter.controller.beginVerification(taskId as never, now);
  const transition = applyGovernorTransition({
    task: current,
    expectedTaskVersion: current.taskVersion,
    expectedLeaseEpoch: current.leaseEpoch,
    to: "FINISH_CANDIDATE",
    now: now + 1,
  });
  if (!transition.applied) {
    throw new Error("pending candidate setup failed");
  }
  expect(
    runtime.adapter.controller.store.commit({
      current,
      next: transition.task,
      event: createGovernorEventRecord({
        task: transition.task,
        eventType: "runtime_finish_proposed",
        payload: {
          phase: "final_response",
          finalResponsePending: true,
          planVersion: transition.task.planVersion,
          progressDigest: transition.task.finalResponsePhase?.progressDigest ?? "",
        },
        now: now + 2,
      }),
    }),
  ).toMatchObject({ applied: true });
}

function invalidate(runtime: ReturnType<typeof start>, taskId: string): void {
  const store = runtime.adapter.controller.store;
  const task = store.loadTask(taskId as never)!;
  const source = store.listAllEvidence(taskId as never)[0]!;
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
      sourceEvidenceId: "pending-correction",
      sourceEvidenceDigest: "e".repeat(64),
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
}

const cases = (["normal", "verifying", "candidate"] as const).flatMap((phase) =>
  (["digest", "evidence"] as const).flatMap((cause) =>
    (["before_rejection", "after_rejection"] as const).map((crash) => ({ phase, cause, crash })),
  ),
) satisfies { phase: Phase; cause: Cause; crash: Crash }[];

async function runPendingFinishCase({
  phase,
  cause,
  crash,
}: {
  phase: Phase;
  cause: Cause;
  crash: Crash;
}): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: `governor-c02-pending-${phase}-${cause}-${crash}-` },
    async (state) => {
      const id = `${phase}-${cause}-${crash}`;
      const runtime = start(state.stateDir);
      const scope = resolveGovernorAgentLoopRunScope(input(id))!;
      observe(scope, 101);
      expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 103 })).toMatchObject({
        phase: "final_response",
      });
      if (phase === "verifying") {
        runtime.adapter.controller.beginVerification(scope.taskId as never, 104);
      } else if (phase === "candidate") {
        persistCandidate(runtime, scope.taskId, 104);
      }
      const agent = new Agent({
        initialState: { model, tools: [...scope.governedTools()] },
        streamFn: scriptedStream(() => assistant([{ type: "text", text: "done" }])),
      });
      const bridge = installGovernorLoopBridge({ agent, scope, now: () => 200 });
      expect(agent.state.tools).toHaveLength(0);
      if (cause === "evidence") {
        invalidate(runtime, scope.taskId);
      }
      const store = runtime.adapter.controller.store;
      const assistantText = cause === "digest" ? "wrong" : "done";
      let rejection: { result?: unknown; error?: unknown };
      if (crash === "before_rejection") {
        const originalCommit = store.commit.bind(store);
        let commits = 0;
        const rejectionCommit = phase === "verifying" && cause === "evidence" ? 2 : 1;
        vi.spyOn(store, "commit").mockImplementation((params) => {
          commits += 1;
          if (commits === rejectionCommit) {
            throw new Error("pending rejection crash");
          }
          return originalCommit(params);
        });
        rejection = capture(() => scope.afterTurn({ assistantText, toolCallCount: 0, now: 205 }));
        vi.restoreAllMocks();
      } else {
        rejection = capture(() => scope.afterTurn({ assistantText, toolCallCount: 0, now: 205 }));
      }
      expect(rejection).toMatchObject(
        crash === "before_rejection"
          ? { error: expect.objectContaining({ message: "pending rejection crash" }) }
          : { result: { kind: "continue", phase: "actions" } },
      );
      scope.dispose();
      if (crash === "after_rejection") {
        bridge.dispose();
      }
      closeOwnedRuntime(runtime);
      closeOpenClawStateDatabase();

      const resumedRuntime = start(state.stateDir);
      const resumed = resolveGovernorAgentLoopRunScope(input(id))!;
      const responseReplay = crash === "before_rejection" && cause === "digest";
      expect(resumed.turnPhase()).toBe(responseReplay ? "final_response" : "actions");
      const resumedAgent = new Agent({
        initialState: { model, tools: [...resumed.governedTools()] },
        streamFn: scriptedStream(() => assistant([{ type: "text", text: "done" }])),
      });
      const resumedBridge = installGovernorLoopBridge({
        agent: resumedAgent,
        scope: resumed,
        now: () => 300,
      });
      const expectedTools = responseReplay ? 0 : resumed.governedTools().length;
      expect(resumedAgent.state.tools).toHaveLength(expectedTools);
      const replay = responseReplay
        ? capture(() => resumed.afterTurn({ assistantText, toolCallCount: 0, now: 305 }))
        : {};
      expect({ phase: resumed.turnPhase(), replay }).toMatchObject(
        responseReplay
          ? {
              phase: "actions",
              replay: { result: { kind: "continue", phase: "actions" } },
            }
          : { phase: "actions", replay: {} },
      );
      expect(resumedAgent.state.tools).toHaveLength(expectedTools);
      resumedBridge.dispose();
      const task = resumedRuntime.adapter.controller.store.loadTask(resumed.taskId as never)!;
      expect(task.state).toBe("REPLAN_REQUIRED");
      expect(task.finalResponsePhase).toBeUndefined();
      expect(
        resumedRuntime.adapter.controller.store
          .listEvents(task.taskId)
          .map((event) => event.eventType),
      ).toContain("finish_rejected");
      const replayed = resumedRuntime.adapter.controller.rejectPendingFinish({
        taskId: task.taskId,
        now: 306,
        pendingUserUpdate: "replay",
      });
      expect(replayed.taskVersion).toBe(task.taskVersion);
      resumed.dispose();
      closeOwnedRuntime(resumedRuntime);
    },
  );
}

afterEach(() => {
  for (const runtime of openRuntimes.splice(0).toReversed()) {
    runtime?.close();
  }
  closeOpenClawStateDatabase();
});

describe("C02 pending finish rejection matrix", () => {
  it.each(cases)("handles $phase/$cause/$crash durably", async (params) => {
    await expect(runPendingFinishCase(params)).resolves.toBeUndefined();
  });
});
