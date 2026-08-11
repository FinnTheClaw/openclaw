// Proves reconcile-before-retry mutations and lease-fenced exactly-once observable delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { governorDigest } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorFanoutStore } from "./fanout.js";
import { GovernorSqliteStore } from "./store.js";
import {
  createGovernorTestStore,
  recordGovernorTestToolOutcome,
  resolveGovernorTestMutation,
} from "./test-broker.js";
import {
  createGovernorEffectId,
  type GovernorPlan,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-mutation",
  channel: "synthetic",
  accountId: "account-mutation",
  conversationId: "conversation-mutation",
  sessionId: "session-mutation",
  agentId: "agent-mutation",
  workspaceId: "workspace-mutation",
};

const contract: GovernorTaskContract = {
  objective: "Apply and verify a synthetic mutation",
  constraints: ["Use synthetic state only"],
  knownFacts: [],
  unknowns: ["mutation state"],
  completionCriteria: [
    { criterionId: "state-verified", description: "Final state is verified", mandatory: true },
  ],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: ["synthetic.mutate"],
    canonicalTargets: ["fixture://state"],
  },
};

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "mutate",
      description: "Apply and verify the synthetic mutation",
      criterionIds: ["state-verified"],
      dependsOn: [],
    },
  ],
};

function capabilities(): GovernorCapabilityRegistry {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.mutate",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
    {
      capability: "synthetic.inspect",
      version: "1",
      sourceRank: "structured_exact",
      mutating: false,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
  ]);
}

async function withGovernor(
  run: (params: {
    controller: GovernorController;
    broker: ReturnType<typeof createGovernorTestStore>["broker"];
    store: GovernorSqliteStore;
    stateDir: string;
  }) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-mutation-" },
    async (state) => {
      const { store, broker } = createGovernorTestStore({ stateDir: state.stateDir });
      try {
        await run({
          controller: new GovernorController(store, capabilities()),
          broker,
          store,
          stateDir: state.stateDir,
        });
      } finally {
        closeOpenClawStateDatabase();
      }
    },
  );
}

function startTask(controller: GovernorController) {
  const taskId = controller.ingest({
    sourceMessageId: "mutation-message-1",
    sourceSequence: 1,
    scope,
    mode: "FOCUSED",
    contract,
    now: 100,
  }).task.taskId;
  controller.preparePlan({ taskId, plan, now: 110 });
  controller.startExecution(taskId, 120);
  return taskId;
}

function mutationProposal(effectSuffix: string) {
  return {
    effectId: createGovernorEffectId(effectSuffix),
    criterionId: "state-verified",
    capability: "synthetic.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://state",
    expectedEvidence: "Exact post-mutation state",
    sourceRank: "structured_exact" as const,
    stopCondition: "Desired state is externally verified",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ target: "state", value: true }),
  };
}

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("governor mutation reconciliation and delivery", () => {
  it("requires reconciliation before retry and post-mutation evidence before completion", async () => {
    await withGovernor(({ controller, store, broker }) => {
      const taskId = startTask(controller);
      const firstFence = controller.captureExecutionFence(taskId);
      const first = controller.recordToolOutcome({
        taskId,
        executionFence: firstFence,
        proposal: mutationProposal("unknown-mutation"),
        progressVector: { desired: false },
        outcome: {
          transport: "unknown",
          semantic: "transient_failure",
          sideEffect: "unknown",
          verification: "required",
          summaryCode: "transport_lost",
        },
        now: 121,
      });
      expect(first.accepted).toBe(true);
      if (!first.accepted) {
        throw new Error("expected unknown mutation record");
      }
      expect(first.effect.reconcileRequired).toBe(true);
      expect(() =>
        controller.recordToolOutcome({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: mutationProposal("unsafe-retry"),
          progressVector: { desired: false, requestId: "volatile" },
          outcome: {
            transport: "completed",
            semantic: "success",
            sideEffect: "applied",
            verification: "required",
            summaryCode: "would_duplicate",
          },
          now: 122,
        }),
      ).toThrow(/reconcile_before_retry/);

      const reconciliationFence = controller.captureExecutionFence(taskId);
      const reconciled = resolveGovernorTestMutation(controller, broker, {
        taskId,
        executionFence: reconciliationFence,
        effectId: first.effect.effectId,
        resolution: "not_applied_verified",
        evidence: { exactState: "unchanged" },
        sourceIdentity: "synthetic.inspect",
        now: 123,
      });
      expect(reconciled.accepted).toBe(true);
      if (!reconciled.accepted) {
        throw new Error("expected mutation reconciliation");
      }
      expect(reconciled.effect).toMatchObject({
        reconcileRequired: false,
        verificationState: "verified",
        outcome: { sideEffect: "none" },
      });

      const secondFence = controller.captureExecutionFence(taskId);
      const applied = controller.recordToolOutcome({
        taskId,
        executionFence: secondFence,
        proposal: mutationProposal("applied-mutation"),
        progressVector: { desired: false, reconciled: true },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "applied",
          verification: "required",
          summaryCode: "applied_unverified",
          evidence: { claimedState: true },
        },
        now: 124,
      });
      expect(applied.accepted).toBe(true);
      if (!applied.accepted) {
        throw new Error("expected applied mutation record");
      }
      expect(applied.evidence).toBeUndefined();
      controller.beginVerification(taskId, 125);
      const premature = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 126,
      });
      expect(premature.completed).toBe(false);
      if (premature.completed) {
        throw new Error("expected premature mutation rejection");
      }
      expect(premature.recovery.unverifiedMutationEffectIds).toEqual([applied.effect.effectId]);

      const verified = resolveGovernorTestMutation(controller, broker, {
        taskId,
        executionFence: {
          objectiveRevision: secondFence.objectiveRevision,
          planVersion: secondFence.planVersion,
          executionGeneration: secondFence.executionGeneration,
        },
        effectId: applied.effect.effectId,
        resolution: "applied_verified",
        evidence: { exactState: true, source: "fixture" },
        sourceIdentity: "synthetic.inspect",
        now: 130,
      });
      expect(verified.accepted).toBe(true);
      expect(store.listEvidence(taskId)).toHaveLength(1);
      // Replanning invalidates the prior-plan receipt, so obtain fresh evidence
      // under the new plan before proposing completion.
      controller.preparePlan({ taskId, plan, now: 140 });
      controller.startExecution(taskId, 150);
      recordGovernorTestToolOutcome(controller, broker, {
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("post-replan-verification"),
          criterionId: "state-verified",
          capability: "synthetic.inspect",
          capabilityVersion: "1",
          canonicalTarget: "fixture://state",
          expectedEvidence: "Current exact state",
          sourceRank: "structured_exact",
          stopCondition: "Current state is verified",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({ target: "state" }),
        },
        progressVector: { verified: true, plan: "current" },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "current_state_verified",
          evidence: { exactState: true, source: "fixture" },
        },
        now: 151,
      });
      controller.beginVerification(taskId, 152);
      const completed = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 153,
      });
      expect(completed.completed).toBe(true);
    });
  });

  it("blocks completion while a durable fanout action is queued", async () => {
    await withGovernor(({ controller, stateDir }) => {
      const taskId = startTask(controller);
      const task = controller.store.loadTask(taskId);
      if (!task) {
        throw new Error("missing task");
      }
      new GovernorFanoutStore({ stateDir }).enqueue({
        jobId: "unfinished-worker",
        task,
        round: 1,
        priority: 0,
        fanoutGroup: "unfinished",
        payload: { safe: true },
        now: 121,
      });
      controller.beginVerification(taskId, 122);
      controller.setPendingUserUpdate({ taskId, pending: true, now: 123 });
      const rejected = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 124,
      });
      expect(rejected.completed).toBe(false);
      if (rejected.completed) {
        throw new Error("expected running-action rejection");
      }
      expect(rejected.recovery).toMatchObject({
        runningActionIds: ["unfinished-worker"],
        pendingUserUpdate: true,
      });
    });
  });

  it("rejects a secret canary before tool evidence, logs, session output, or outbox state", async () => {
    await withGovernor(({ controller, store, broker }) => {
      const taskId = startTask(controller);
      expect(() =>
        recordGovernorTestToolOutcome(controller, broker, {
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: {
            effectId: createGovernorEffectId("secret-output"),
            criterionId: "state-verified",
            capability: "synthetic.inspect",
            capabilityVersion: "1",
            canonicalTarget: "fixture://state",
            expectedEvidence: "Exact state",
            sourceRank: "structured_exact",
            stopCondition: "State is exact",
            mutating: false,
            argumentsDigest: governorArgumentsDigest({ target: "state" }),
          },
          progressVector: { verified: false },
          outcome: {
            transport: "completed",
            semantic: "success",
            sideEffect: "not_applicable",
            verification: "not_required",
            summaryCode: "unsafe",
            evidence: { note: "GOVERNOR_SECRET_CANARY_tool_output" },
          },
          now: 121,
        }),
      ).toThrow(/rejected secret-like content/);
      expect(store.listEffects(taskId)).toEqual([]);
      expect(JSON.stringify(store.listEvents(taskId))).not.toContain("CANARY_tool_output");

      recordGovernorTestToolOutcome(controller, broker, {
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("safe-output"),
          criterionId: "state-verified",
          capability: "synthetic.inspect",
          capabilityVersion: "1",
          canonicalTarget: "fixture://state",
          expectedEvidence: "Exact state",
          sourceRank: "structured_exact",
          stopCondition: "State is exact",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({ target: "state" }),
        },
        progressVector: { verified: true },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "safe",
          evidence: { exactState: true },
        },
        now: 122,
      });
      controller.beginVerification(taskId, 123);
      expect(() =>
        controller.proposeFinish({
          taskId,
          response: {
            framing: "summary",
            materialClaimIds: ["GOVERNOR_SECRET_CANARY_session_output"],
          },
          now: 124,
        }),
      ).toThrow(/rejected secret-like content/);
      expect(store.loadTask(taskId)?.state).toBe("VERIFYING");
      expect(store.outbox.list(taskId)).toEqual([]);
    });
  });

  it("reclaims a crashed delivery lease without an observable duplicate", async () => {
    await withGovernor(({ controller, store, stateDir, broker }) => {
      const taskId = startTask(controller);
      recordGovernorTestToolOutcome(controller, broker, {
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("inspection"),
          criterionId: "state-verified",
          capability: "synthetic.inspect",
          capabilityVersion: "1",
          canonicalTarget: "fixture://state",
          expectedEvidence: "Exact state",
          sourceRank: "structured_exact",
          stopCondition: "State is exact",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({ target: "state" }),
        },
        progressVector: { verified: true },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "verified",
          evidence: { exactState: true },
        },
        now: 121,
      });
      controller.beginVerification(taskId, 122);
      const completed = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 123,
      });
      expect(completed.completed).toBe(true);
      if (!completed.completed) {
        throw new Error("expected completed task");
      }
      const effectId = store.outbox.list(taskId)[0]?.effectId;
      if (!effectId) {
        throw new Error("missing completion outbox entry");
      }

      const delivered = new Map<string, { providerId: string }>();
      const providerSend = vi.fn((deliveryKey: string) => {
        const existing = delivered.get(deliveryKey);
        if (existing) {
          return existing;
        }
        const receipt = { providerId: "one-observable-message" };
        delivered.set(deliveryKey, receipt);
        return receipt;
      });
      const deliveryBinding = {
        adapterHandle: "opaque-adapter-handle",
        identityKey: "opaque-identity-key",
        implementationDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        generation: 1,
        channel: "synthetic",
        accountIdentity: "opaque-account",
        targetIdentity: "opaque-target",
        deploymentIdentity: "opaque-deployment",
      } as const;
      const oldClaim = store.outbox.claim({
        taskId,
        effectId,
        expectedLeaseEpoch: completed.task.leaseEpoch,
        workerId: "old-worker",
        leaseDurationMs: 10,
        now: 130,
        deliveryBinding,
      });
      expect(oldClaim.kind).toBe("claimed");
      if (oldClaim.kind !== "claimed") {
        throw new Error("expected first delivery claim");
      }
      providerSend(oldClaim.entry.deliveryKey);

      closeOpenClawStateDatabase();
      const restartedStore = new GovernorSqliteStore({ stateDir });
      const newClaim = restartedStore.outbox.claim({
        taskId,
        effectId,
        expectedLeaseEpoch: completed.task.leaseEpoch,
        workerId: "new-worker",
        leaseDurationMs: 10,
        now: 141,
        deliveryBinding,
      });
      expect(newClaim.kind).toBe("reconcile_required");
      if (newClaim.kind !== "reconcile_required") {
        throw new Error("expected reconciliation fence after an ambiguous crash");
      }
      expect(() =>
        restartedStore.outbox.markManualReview({
          taskId,
          effectId,
          expectedLeaseEpoch: completed.task.leaseEpoch,
          expectedDeliveryClaimEpoch: newClaim.entry.deliveryClaimEpoch,
          reasonDigest: "authoritative-status-unavailable",
          now: 142,
        }),
      ).toThrow(/must be a SHA-256 digest/u);
      expect(
        restartedStore.outbox.markManualReview({
          taskId,
          effectId,
          expectedLeaseEpoch: completed.task.leaseEpoch,
          expectedDeliveryClaimEpoch: newClaim.entry.deliveryClaimEpoch,
          reasonDigest: governorDigest({ reason: "authoritative-status-unavailable" }),
          now: 142,
        }).kind,
      ).toBe("manual_review");
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(delivered.size).toBe(1);
      expect(restartedStore.outbox.list(taskId)[0]).toMatchObject({ state: "manual_review" });
    });
  });
});
