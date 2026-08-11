// Proves expired approval claims are cancelled before revocation and cannot record late results.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { governorActionTerminationReceiptPayload } from "./action-execution-lifecycle.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestBroker } from "./test-broker.js";
import { createGovernorEffectId, type GovernorTaskId, type GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "approval-lease-principal",
  channel: "synthetic",
  accountId: "approval-lease-account",
  conversationId: "approval-lease-conversation",
  sessionId: "approval-lease-session",
  agentId: "approval-lease-agent",
  workspaceId: "approval-lease-workspace",
};

const contract = {
  objective: "Apply one approved fixture mutation",
  constraints: [],
  knownFacts: [],
  unknowns: ["final state"],
  completionCriteria: [
    { criterionId: "verified", description: "Mutation verified", mandatory: true },
  ],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: ["approval-lease.mutate"],
    canonicalTargets: ["fixture://approval-lease"],
  },
};

const plan = {
  kind: "ordered" as const,
  steps: [{ stepId: "mutate", description: "Mutate", criterionIds: ["verified"], dependsOn: [] }],
};

function capabilities() {
  return new GovernorCapabilityRegistry([
    {
      capability: "approval-lease.mutate",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: true,
    },
  ]);
}

function proposal(
  taskId: GovernorTaskId,
  effectId: ReturnType<typeof createGovernorEffectId>,
  grantId: string,
) {
  return {
    taskId,
    effectId,
    criterionId: "verified",
    capability: "approval-lease.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://approval-lease",
    expectedEvidence: "Exact fixture state",
    sourceRank: "structured_exact" as const,
    stopCondition: "Fixture is verified",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ value: true }),
    approvalGrantId: grantId,
  };
}

function createApproval(
  broker: ReturnType<typeof createGovernorTestBroker>,
  store: GovernorSqliteStore,
  taskId: GovernorTaskId,
  now: number,
) {
  const task = store.loadTask(taskId);
  if (!task) {
    throw new Error("expected approval task");
  }
  const receiptId = broker.capabilities.submitAuthenticatedApproval({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    objectiveRevision: task.objectiveRevision,
    capability: "approval-lease.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://approval-lease",
    approverIdentity: "synthetic-approver",
    approvalEpoch: 0,
    expiresAt: 500,
    observedAt: now,
  });
  return store.admitAuthenticatedApproval({ task, receiptId, now });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor approval lease fencing", () => {
  it("lets revocation cancel an unstarted live claim before the effect fence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-revoke-first-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const registry = capabilities();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          secrets: broker.secrets,
          capabilities: registry,
        });
        const controller = new GovernorController(store, registry);
        const taskId = controller.ingest({
          sourceMessageId: "approval-revoke-first-message",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 50,
        }).task.taskId;
        controller.preparePlan({ taskId, plan, now: 51 });
        controller.startExecution(taskId, 52);
        const task = store.loadTask(taskId);
        if (!task) {
          throw new Error("expected revoke-first task");
        }
        const grantId = createApproval(broker, store, taskId, 53);
        const admitted = controller.admitAction({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: proposal(taskId, createGovernorEffectId("revoke-first"), grantId),
          progressVector: { phase: "queued" },
          now: 54,
        });
        if (!admitted.accepted) {
          throw new Error("expected revoke-first admission");
        }
        const claim = controller.claimActionIntent({
          intent: admitted.intent,
          workerId: "revoke-first-worker",
          leaseDurationMs: 100,
          now: 55,
        });
        if (claim.kind !== "claimed") {
          throw new Error("expected revoke-first claim");
        }
        const receiptId = broker.capabilities.submitApprovalRevocation({
          grantId,
          scopeKey: task.scopeKey,
          observedAt: 56,
        });
        expect(store.applyAuthenticatedApprovalRevocation({ grantId, receiptId })).toBe(true);
        expect(
          controller.beginActionEffect({
            intent: claim.intent,
            workerId: "revoke-first-worker",
            claimEpoch: claim.intent.claimEpoch,
            now: 57,
          }),
        ).toMatchObject({ kind: "stale_worker" });
        expect(store.actionIntents.load(taskId, claim.intent.effectId)).toMatchObject({
          state: "cancelled",
        });
        expect(store.listEffects(taskId)).toEqual([]);
      },
    );
  });

  it("cancels an expired claim, revokes durably, and rejects the stale result after restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-lease-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const registry = capabilities();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          secrets: broker.secrets,
          capabilities: registry,
        });
        const controller = new GovernorController(store, registry);
        const taskId = controller.ingest({
          sourceMessageId: "approval-lease-message",
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
        const grantId = createApproval(broker, store, taskId, 103);
        const effectId = createGovernorEffectId("expired-claim");
        const admitted = controller.admitAction({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: proposal(taskId, effectId, grantId),
          progressVector: { phase: "queued" },
          now: 104,
        });
        if (!admitted.accepted) {
          throw new Error("expected admitted action");
        }
        const claim = controller.claimActionIntent({
          intent: admitted.intent,
          workerId: "expired-worker",
          leaseDurationMs: 10,
          now: 105,
        });
        if (claim.kind !== "claimed") {
          throw new Error("expected claim");
        }
        expect(
          controller.beginActionEffect({
            intent: claim.intent,
            workerId: "expired-worker",
            claimEpoch: claim.intent.claimEpoch,
            now: 116,
          }),
        ).toMatchObject({ kind: "stale_worker" });

        const revocationReceipt = broker.capabilities.submitApprovalRevocation({
          grantId,
          scopeKey: task.scopeKey,
          observedAt: 116,
        });
        expect(
          store.applyAuthenticatedApprovalRevocation({
            grantId,
            receiptId: revocationReceipt,
          }),
        ).toBe(true);
        expect(store.approvalStatus(task, proposal(taskId, effectId, grantId), 116)).toBe(
          "revoked",
        );

        const late = controller.recordAdmittedToolOutcome({
          taskId,
          intent: claim.intent,
          workerId: "expired-worker",
          claimEpoch: claim.intent.claimEpoch,
          outcome: {
            transport: "completed",
            semantic: "success",
            sideEffect: "applied",
            verification: "verified",
            summaryCode: "late-after-revoke",
          },
          now: 117,
        });
        expect(late).toMatchObject({ accepted: false, reason: "stale_execution" });
        expect(store.listEffects(taskId)).toEqual([]);

        closeOpenClawStateDatabase();
        const restartedBroker = createGovernorTestBroker({ stateDir: state.stateDir });
        const restartedCapabilities = capabilities();
        const restartedStore = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: restartedBroker.resolver,
          approvalResolver: restartedBroker.approvalResolver,
          deliveryResolver: restartedBroker.deliveryResolver,
          secrets: restartedBroker.secrets,
          capabilities: restartedCapabilities,
        });
        const restartedController = new GovernorController(restartedStore, restartedCapabilities);
        expect(restartedStore.approvalStatus(task, proposal(taskId, effectId, grantId), 118)).toBe(
          "revoked",
        );
        expect(
          restartedController.recordAdmittedToolOutcome({
            taskId,
            intent: claim.intent,
            workerId: "expired-worker",
            claimEpoch: claim.intent.claimEpoch,
            outcome: {
              transport: "completed",
              semantic: "success",
              sideEffect: "applied",
              verification: "verified",
              summaryCode: "replayed-late-result",
            },
            now: 119,
          }),
        ).toMatchObject({ accepted: false, reason: "stale_execution" });
        expect(restartedStore.listEffects(taskId)).toEqual([]);
      },
    );
  });

  it("linearizes effect start against revocation and requires authenticated termination", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-effect-fence-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const registry = capabilities();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          secrets: broker.secrets,
          capabilities: registry,
        });
        const controller = new GovernorController(store, registry);
        const taskId = controller.ingest({
          sourceMessageId: "approval-effect-message",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 200,
        }).task.taskId;
        controller.preparePlan({ taskId, plan, now: 201 });
        controller.startExecution(taskId, 202);
        const task = store.loadTask(taskId);
        if (!task) {
          throw new Error("expected effect-fence task");
        }
        const grantId = createApproval(broker, store, taskId, 203);
        const admitted = controller.admitAction({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: proposal(taskId, createGovernorEffectId("started-effect"), grantId),
          progressVector: { phase: "queued" },
          now: 204,
        });
        if (!admitted.accepted) {
          throw new Error("expected effect-fence admission");
        }
        const claim = controller.claimActionIntent({
          intent: admitted.intent,
          workerId: "effect-worker",
          leaseDurationMs: 10,
          now: 205,
        });
        if (claim.kind !== "claimed") {
          throw new Error("expected effect-fence claim");
        }
        const started = controller.beginActionEffect({
          intent: claim.intent,
          workerId: "effect-worker",
          claimEpoch: claim.intent.claimEpoch,
          now: 206,
        });
        if (started.kind !== "started") {
          throw new Error("expected effect to start");
        }

        expect(() =>
          broker.capabilities.submitApprovalRevocation({
            grantId,
            scopeKey: task.scopeKey,
            observedAt: 216,
          }),
        ).toThrow(/not durably applied/u);
        const cancelling = store.actionIntents.load(taskId, started.intent.effectId);
        expect(cancelling?.cancellationRequestedAt).toBe(216);
        if (!cancelling) {
          throw new Error("expected cancelling intent");
        }

        const unknownPayload = governorActionTerminationReceiptPayload(cancelling, "unknown");
        const unknownReceipt = broker.capabilities.submitObservedReceipt({
          scopeKey: task.scopeKey,
          taskId,
          taskVersion: cancelling.taskVersion,
          objectiveRevision: cancelling.objectiveRevision,
          planVersion: cancelling.planVersion,
          sourceKind: "structured_external",
          sourceIdentity: "synthetic-action-runner",
          payload: unknownPayload,
          observedAt: 217,
        });
        const acknowledged = controller.acknowledgeActionTermination({
          taskId,
          effectId: cancelling.effectId,
          receiptId: unknownReceipt,
          outcome: "unknown",
          now: 217,
        });
        expect(acknowledged.kind).toBe("acknowledged");
        expect(store.actionIntents.listPendingIds(taskId, 1)).toContain(cancelling.effectId);

        const revocationReceipt = broker.capabilities.submitApprovalRevocation({
          grantId,
          scopeKey: task.scopeKey,
          observedAt: 218,
        });
        expect(
          store.applyAuthenticatedApprovalRevocation({ grantId, receiptId: revocationReceipt }),
        ).toBe(true);

        const unknown = store.actionIntents.load(taskId, cancelling.effectId);
        if (!unknown) {
          throw new Error("expected unknown terminal intent");
        }
        const resolutionPayload = governorActionTerminationReceiptPayload(
          unknown,
          "confirmed_not_applied",
        );
        const resolutionReceipt = broker.capabilities.submitObservedReceipt({
          scopeKey: task.scopeKey,
          taskId,
          taskVersion: unknown.taskVersion,
          objectiveRevision: unknown.objectiveRevision,
          planVersion: unknown.planVersion,
          sourceKind: "structured_external",
          sourceIdentity: "synthetic-action-reconciler",
          payload: resolutionPayload,
          observedAt: 219,
        });
        expect(
          controller.acknowledgeActionTermination({
            taskId,
            effectId: unknown.effectId,
            receiptId: resolutionReceipt,
            outcome: "confirmed_not_applied",
            now: 219,
          }),
        ).toMatchObject({ kind: "acknowledged" });
        expect(
          controller.acknowledgeActionTermination({
            taskId,
            effectId: unknown.effectId,
            receiptId: resolutionReceipt,
            outcome: "confirmed_not_applied",
            now: 220,
          }),
        ).toMatchObject({ kind: "acknowledged" });
        expect(store.actionIntents.listPendingIds(taskId, 1)).not.toContain(cancelling.effectId);
        expect(
          controller.recordAdmittedToolOutcome({
            taskId,
            intent: started.intent,
            workerId: "effect-worker",
            claimEpoch: started.intent.claimEpoch,
            outcome: {
              transport: "completed",
              semantic: "success",
              sideEffect: "applied",
              verification: "verified",
              summaryCode: "stale-after-termination",
            },
            now: 220,
          }),
        ).toMatchObject({ accepted: false, reason: "stale_execution" });
        expect(store.listEffects(taskId)).toEqual([]);
      },
    );
  });
});
