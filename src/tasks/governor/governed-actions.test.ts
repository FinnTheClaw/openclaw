// Verifies capability authority, semantic no-progress, and stale execution-result fencing.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorActionRejectedError, GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { evaluateGovernorActionAdmission, governorProgressVectorHash } from "./progress-monitor.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorEffectRecord, type GovernorActionProposal } from "./tool-outcome.js";
import {
  createGovernorEffectId,
  createGovernorIdentityContext,
  createGovernorTaskProjection,
  type GovernorPlan,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

const identity = createGovernorIdentityContext("synthetic-governed-actions-key");

const scope: GovernorTaskScope = {
  principalId: "principal-actions",
  channel: "synthetic",
  accountId: "account-actions",
  conversationId: "conversation-actions",
  sessionId: "session-actions",
  agentId: "agent-actions",
  workspaceId: "workspace-actions",
};

function contract(mutating = false): GovernorTaskContract {
  return {
    objective: "Verify action governance",
    constraints: [],
    knownFacts: [],
    unknowns: ["state"],
    completionCriteria: [
      { criterionId: "verified", description: "State verified", mandatory: true },
    ],
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: mutating ? ["synthetic.mutate"] : [],
      canonicalTargets: mutating ? ["fixture://mutable"] : [],
    },
  };
}

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "inspect",
      description: "Inspect state",
      criterionIds: ["verified"],
      dependsOn: [],
    },
  ],
};

function registry(): GovernorCapabilityRegistry {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.read",
      version: "1",
      sourceRank: "structured_exact",
      mutating: false,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
    {
      capability: "synthetic.mutate",
      version: "2",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://mutable"],
      requiresApproval: true,
    },
  ]);
}

function readProposal(effectId: string): GovernorActionProposal {
  return {
    taskId: createGovernorTaskProjection({
      scope,
      mode: "DEEP",
      contract: contract(),
      authenticatedSourceSequence: 1,
      now: 1,
      identity,
    }).taskId,
    effectId: createGovernorEffectId(effectId),
    criterionId: "verified",
    capability: "synthetic.read",
    capabilityVersion: "1",
    canonicalTarget: "fixture://state",
    expectedEvidence: "Exact state",
    sourceRank: "structured_exact",
    stopCondition: "State found",
    mutating: false,
    argumentsDigest: governorArgumentsDigest({ target: "state" }),
  };
}

function readProposalInput(effectId: string): Omit<GovernorActionProposal, "taskId"> {
  const { taskId: _ignoredTaskId, ...proposal } = readProposal(effectId);
  return proposal;
}

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("governed actions", () => {
  it("binds privileged actions to current objective, capability version, and target", () => {
    const task = createGovernorTaskProjection({
      scope,
      mode: "INCIDENT",
      contract: contract(true),
      authenticatedSourceSequence: 1,
      now: 100,
      identity,
    });
    const proposal: GovernorActionProposal = {
      ...readProposal("mutation"),
      taskId: task.taskId,
      capability: "synthetic.mutate",
      capabilityVersion: "2",
      canonicalTarget: "fixture://mutable",
      mutating: true,
      approvalGrantId: "approval-1",
    };
    expect(() => registry().assertAuthorized(task, proposal)).not.toThrow();
    expect(() =>
      registry().assertAuthorized(task, { ...proposal, canonicalTarget: "fixture://other" }),
    ).toThrow(new GovernorActionRejectedError("target_not_supported"));
  });

  it("treats volatile request metadata as no semantic progress and rejects a third repeat", () => {
    const proposal = readProposal("first");
    const base: Parameters<typeof createGovernorEffectRecord>[0] = {
      proposal,
      taskVersion: 1,
      objectiveRevision: 1,
      planVersion: 1,
      leaseEpoch: 0,
      executionGeneration: 0,
      progressVector: { verified: [], requestId: "request-a", timestamp: 100 },
      outcome: {
        transport: "completed",
        semantic: "not_found",
        sideEffect: "not_applicable",
        verification: "not_required",
        summaryCode: "missing",
      },
      now: 100,
      identity,
    };
    const first = createGovernorEffectRecord(base);
    const secondProposal = { ...proposal, effectId: createGovernorEffectId("second") };
    const second = createGovernorEffectRecord({
      ...base,
      proposal: secondProposal,
      progressVector: { verified: [], requestId: "request-b", timestamp: 200 },
      now: 200,
    });
    expect(governorProgressVectorHash({ verified: [], requestId: "x", updatedAt: 1 })).toBe(
      governorProgressVectorHash({ verified: [], requestId: "y", updatedAt: 2 }),
    );
    expect(
      evaluateGovernorActionAdmission({
        proposal: { ...proposal, effectId: createGovernorEffectId("third") },
        progressVector: { verified: [], requestId: "request-c", timestamp: 300 },
        priorEffects: [first, second],
        objectiveRevision: 1,
        identity,
      }),
    ).toMatchObject({ admitted: false, reason: "no_progress_limit" });
  });

  it("records a post-correction tool result as audit-only", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-late-result-" },
      async (state) => {
        const capabilities = registry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
        try {
          const taskId = controller.ingest({
            sourceMessageId: "message-1",
            sourceSequence: 1,
            scope,
            mode: "DEEP",
            contract: contract(),
            now: 100,
          }).task.taskId;
          controller.preparePlan({ taskId, plan, now: 110 });
          controller.startExecution(taskId, 120);
          const executionFence = controller.captureExecutionFence(taskId);
          const corrected = controller.ingest({
            sourceMessageId: "message-2",
            sourceSequence: 2,
            scope,
            mode: "DEEP",
            contract: { ...contract(), objective: "Corrected objective" },
            now: 121,
          });
          const result = controller.recordToolOutcome({
            taskId,
            executionFence,
            proposal: readProposalInput("late-result"),
            progressVector: { verified: ["verified"] },
            outcome: {
              transport: "completed",
              semantic: "success",
              sideEffect: "not_applicable",
              verification: "not_required",
              summaryCode: "late",
              evidence: { state: "old-objective" },
            },
            now: 122,
          });
          expect(result).toMatchObject({ accepted: false, reason: "stale_execution" });
          expect(store.listEffects(taskId)).toEqual([]);
          expect(store.listEvidence(taskId)).toEqual([]);
          expect(store.loadTask(taskId)).toMatchObject({
            objectiveRevision: corrected.task.objectiveRevision,
            contract: { objective: "Corrected objective" },
          });
          expect(store.listEvents(taskId).at(-1)?.eventType).toBe("late_tool_result_ignored");
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("forces replanning after two equivalent no-delta outcomes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-no-progress-" },
      async (state) => {
        const capabilities = registry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
        try {
          const taskId = controller.ingest({
            sourceMessageId: "message-no-progress",
            sourceSequence: 1,
            scope,
            mode: "DEEP",
            contract: contract(),
            now: 200,
          }).task.taskId;
          controller.preparePlan({ taskId, plan, now: 210 });
          controller.startExecution(taskId, 220);
          const executionFence = controller.captureExecutionFence(taskId);
          const outcome = {
            transport: "completed",
            semantic: "not_found",
            sideEffect: "not_applicable",
            verification: "not_required",
            summaryCode: "same-miss",
          } as const;
          const first = controller.recordToolOutcome({
            taskId,
            executionFence,
            proposal: readProposalInput("no-progress-1"),
            progressVector: { verified: [], requestId: "first" },
            outcome,
            now: 221,
          });
          expect(first).toMatchObject({ accepted: true, task: { state: "EXECUTING" } });
          const second = controller.recordToolOutcome({
            taskId,
            executionFence,
            proposal: readProposalInput("no-progress-2"),
            progressVector: { verified: [], requestId: "second" },
            outcome,
            now: 222,
          });
          expect(second).toMatchObject({ accepted: true, task: { state: "REPLAN_REQUIRED" } });
          expect(store.listEffects(taskId)).toHaveLength(2);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
