// Proves persisted approval flags cannot weaken the configured capability policy.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { createGovernorEventRecord } from "./events.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestBroker } from "./test-broker.js";
import { createGovernorEffectId, type GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-policy",
  channel: "synthetic",
  accountId: "account-policy",
  conversationId: "conversation-policy",
  sessionId: "session-policy",
  agentId: "agent-policy",
  workspaceId: "workspace-policy",
};

function capabilities() {
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

afterEach(() => closeOpenClawStateDatabase());

describe("governor action approval policy fence", () => {
  it("recomputes approval policy at persistence and execution claim", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-policy-fence-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const registry = capabilities();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          capabilities: registry,
        });
        const controller = new GovernorController(store, registry);
        const taskId = controller.ingest({
          sourceMessageId: "policy-fence-message",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract: {
            objective: "Apply one approved fixture change",
            constraints: [],
            knownFacts: [],
            unknowns: [],
            completionCriteria: [
              { criterionId: "changed", description: "Fixture changed", mandatory: true },
            ],
            authority: {
              allowReadOnlyDiscovery: true,
              mutationCapabilities: ["fixture.mutate"],
              canonicalTargets: ["fixture://target"],
            },
          },
          now: 10,
        }).task.taskId;
        controller.preparePlan({
          taskId,
          plan: {
            kind: "ordered",
            steps: [
              {
                stepId: "apply",
                description: "Apply",
                criterionIds: ["changed"],
                dependsOn: [],
              },
            ],
          },
          now: 11,
        });
        controller.startExecution(taskId, 12);
        const task = store.loadTask(taskId);
        if (!task) {
          throw new Error("expected task");
        }
        const receiptId = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "fixture.mutate",
          capabilityVersion: "1",
          canonicalTarget: "fixture://target",
          approverIdentity: "synthetic-policy-owner",
          approvalEpoch: 0,
          expiresAt: 100,
          observedAt: 13,
        });
        const grantId = store.admitAuthenticatedApproval({ task, receiptId, now: 13 });
        const effectId = createGovernorEffectId("policy-fence");
        const admitted = controller.admitAction({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: {
            effectId,
            criterionId: "changed",
            capability: "fixture.mutate",
            capabilityVersion: "1",
            canonicalTarget: "fixture://target",
            expectedEvidence: "Fixture state",
            sourceRank: "structured_exact",
            stopCondition: "Fixture changed",
            mutating: true,
            argumentsDigest: governorArgumentsDigest({ target: "fixture://target" }),
            approvalGrantId: grantId,
          },
          progressVector: { phase: "queued" },
          now: 14,
        });
        if (!admitted.accepted) {
          throw new Error("expected action admission");
        }
        const current = store.loadTask(taskId);
        if (!current) {
          throw new Error("expected current task");
        }
        const next = { ...current, taskVersion: current.taskVersion + 1, updatedAt: 15 };
        expect(() =>
          store.commit({
            current,
            next,
            event: createGovernorEventRecord({
              task: next,
              eventType: "action_admitted",
              payload: { adversarialPolicyReplay: true },
              now: 15,
            }),
            actionIntents: [{ ...admitted.intent, approvalRequired: false }],
          }),
        ).toThrow(/GOVERNOR_ACTION_POLICY_BINDING_INVALID/u);

        openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: state.stateDir } })
          .db.prepare(
            "UPDATE governor_action_intents SET approval_required = 0 WHERE task_id = ? AND effect_id = ?",
          )
          .run(taskId, effectId);
        expect(controller.isActionIntentExecutable(admitted.intent)).toBe(false);
        expect(
          controller.claimActionIntent({
            intent: admitted.intent,
            workerId: "policy-fence-worker",
            now: 16,
          }),
        ).toEqual({ kind: "stale_worker" });
      },
    );
  });
});
