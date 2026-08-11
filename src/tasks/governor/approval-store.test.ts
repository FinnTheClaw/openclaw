import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestBroker } from "./test-broker.js";
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

function proposal(
  taskId: Parameters<GovernorSqliteStore["approvalStatus"]>[0]["taskId"],
  effectId: ReturnType<typeof createGovernorEffectId>,
  approvalGrantId: string,
) {
  return {
    taskId,
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
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
        });
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
              proposal: proposal(task.taskId, createGovernorEffectId("forged"), "forged-grant"),
              progressVector: { step: 1 },
              now: 106,
            }),
          ).toThrow("approval_required");
          expect("issue" in store).toBe(false);
          const receiptId = broker.capabilities.submitAuthenticatedApproval({
            scopeKey: task.scopeKey,
            taskId: task.taskId,
            objectiveRevision: task.objectiveRevision,
            capability: "fixture.mutate",
            capabilityVersion: "1",
            canonicalTarget: "fixture://target",
            approverIdentity: "synthetic-host-approval-event",
            approvalEpoch: 0,
            expiresAt: 200,
            observedAt: 108,
          });
          const grantId = store.admitAuthenticatedApproval({ task, receiptId, now: 108 });
          expect(grantId).toMatch(/^ggrant_/u);
          expect(
            controller.admitAction({
              taskId,
              executionFence: controller.captureExecutionFence(taskId),
              proposal: proposal(task.taskId, createGovernorEffectId("approved"), grantId),
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
              proposal: proposal(task.taskId, createGovernorEffectId("stale"), grantId),
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

  it("durably fences revocation before cache use and across restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-adversarial-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const makeStore = () =>
          new GovernorSqliteStore({
            stateDir: state.stateDir,
            receiptResolver: broker.resolver,
            approvalResolver: broker.approvalResolver,
            deliveryResolver: broker.deliveryResolver,
          });
        const store = makeStore();
        const controller = new GovernorController(store, registry());
        const taskId = controller.ingest({
          sourceMessageId: "message-1",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task.taskId;
        controller.preparePlan({ taskId, plan, now: 101 });
        controller.startExecution(taskId, 102);
        const task = store.loadTask(taskId);
        if (!task) {
          throw new Error("expected task");
        }
        expect(() =>
          store.admitAuthenticatedApproval({
            task,
            receiptId: "ghr_invented" as never,
            now: 103,
          }),
        ).toThrow("invalid");
        const expired = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "fixture.mutate",
          capabilityVersion: "1",
          canonicalTarget: "fixture://target",
          approverIdentity: "synthetic",
          approvalEpoch: 0,
          expiresAt: 103,
          observedAt: 102,
        });
        expect(() =>
          store.admitAuthenticatedApproval({ task, receiptId: expired, now: 103 }),
        ).toThrow("expired");
        const valid = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "fixture.mutate",
          capabilityVersion: "1",
          canonicalTarget: "fixture://target",
          approverIdentity: "synthetic",
          approvalEpoch: 0,
          expiresAt: 200,
          observedAt: 104,
        });
        const grantId = store.admitAuthenticatedApproval({ task, receiptId: valid, now: 104 });
        // A failed pre-commit revocation cannot be reported as success or
        // poison the broker cache; the durable grant remains usable.
        expect(() =>
          broker.capabilities.submitApprovalRevocation({
            grantId: "missing-grant",
            scopeKey: task.scopeKey,
            observedAt: 105,
          }),
        ).toThrow(/not durably applied/);
        expect(
          store.approvalStatus(
            task,
            proposal(task.taskId, createGovernorEffectId("before-commit-failure"), grantId),
            105,
          ),
        ).toBe("approved");
        // Host revocation commits its epoch and grant tombstone before it
        // returns a receipt. A process crash immediately here must not revive
        // the grant on a fresh broker with an empty in-memory cache.
        const revokeReceipt = broker.capabilities.submitApprovalRevocation({
          grantId,
          scopeKey: task.scopeKey,
          observedAt: 105,
        });
        expect(
          store.applyAuthenticatedApprovalRevocation({ grantId, receiptId: revokeReceipt }),
        ).toBe(true);
        closeOpenClawStateDatabase();
        const restartedBroker = createGovernorTestBroker({ stateDir: state.stateDir });
        const restarted = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: restartedBroker.resolver,
          approvalResolver: restartedBroker.approvalResolver,
          deliveryResolver: restartedBroker.deliveryResolver,
        });
        expect(
          restarted.approvalStatus(
            task,
            proposal(task.taskId, createGovernorEffectId("replayed"), grantId),
            106,
          ),
        ).toBe("revoked");
      },
    );
  });
});
