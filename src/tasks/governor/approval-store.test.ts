import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorEffectId, type GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal",
  channel: "synthetic",
  accountId: "account",
  conversationId: "conversation",
  sessionId: "session",
  agentId: "agent",
  workspaceId: "workspace",
};

const contract = {
  objective: "Apply a tested fixture change",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [{ criterionId: "changed", description: "Fixture changed", mandatory: true }],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: ["fixture.mutate"],
    canonicalTargets: ["fixture://target"],
  },
};

const plan = {
  kind: "ordered" as const,
  steps: [{ stepId: "apply", description: "Apply", criterionIds: ["changed"], dependsOn: [] }],
};

function registry() {
  return new GovernorCapabilityRegistry([
    {
      capability: "fixture.mutate",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: true,
    },
  ]);
}

function proposal(effectId: ReturnType<typeof createGovernorEffectId>, approvalGrantId: string) {
  return {
    effectId,
    criterionId: "changed",
    capability: "fixture.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://target",
    expectedEvidence: "Fixture state",
    sourceRank: "structured_exact" as const,
    stopCondition: "Fixture changed",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ target: "fixture://target" }),
    approvalGrantId,
  };
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor approval grants", () => {
  it("requires a host-authenticated durable grant and fences it on correction", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, registry());
        try {
          const taskId = controller.ingest({
            sourceMessageId: "message-1",
            sourceSequence: 1,
            scope,
            mode: "FOCUSED",
            contract,
            now: 100,
          }).task.taskId;
          controller.preparePlan({ taskId, plan, now: 101 });
          controller.startExecution(taskId, 105);
          const task = store.loadTask(taskId);
          if (!task) {
            throw new Error("expected task");
          }
          expect(() =>
            controller.admitAction({
              taskId,
              executionFence: controller.captureExecutionFence(taskId),
              proposal: proposal(createGovernorEffectId("forged"), "forged-grant"),
              progressVector: { step: 1 },
              now: 106,
            }),
          ).toThrow("approval_required");
          expect(() =>
            store.approvals.issue({
              task,
              issuerId: "unverified-owner",
              capability: "fixture.mutate",
              capabilityVersion: "1",
              canonicalTarget: "fixture://target",
              expiresAt: 200,
              now: 107,
            }),
          ).toThrow("host-authenticated");
          const grant = store.approvals.issue({
            task,
            issuerId: "test-host-approver",
            capability: "fixture.mutate",
            capabilityVersion: "1",
            canonicalTarget: "fixture://target",
            expiresAt: 200,
            now: 108,
          });
          expect(grant.grantId).toMatch(/^ggrant_/u);
          expect(grant.issuerId).not.toBe("test-host-approver");
          expect(
            controller.admitAction({
              taskId,
              executionFence: controller.captureExecutionFence(taskId),
              proposal: proposal(createGovernorEffectId("approved"), grant.grantId),
              progressVector: { step: 1 },
              now: 109,
            }).accepted,
          ).toBe(true);
          controller.ingest({
            sourceMessageId: "message-2",
            sourceSequence: 2,
            scope,
            mode: "FOCUSED",
            contract: { ...contract, objective: "Corrected objective" },
            now: 110,
          });
          controller.preparePlan({ taskId, plan, now: 111 });
          controller.startExecution(taskId, 115);
          expect(() =>
            controller.admitAction({
              taskId,
              executionFence: controller.captureExecutionFence(taskId),
              proposal: proposal(createGovernorEffectId("stale"), grant.grantId),
              progressVector: { step: 2 },
              now: 116,
            }),
          ).toThrow("approval_stale");
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
