// Proves pre-execution durability, stable idempotency, and correction fences for tool actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { governorDigest } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore, recordGovernorTestAdmittedToolOutcome } from "./test-broker.js";
import {
  createGovernorEffectId,
  type GovernorPlan,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-intent",
  channel: "synthetic",
  accountId: "account-intent",
  conversationId: "conversation-intent",
  sessionId: "session-intent",
  agentId: "agent-intent",
  workspaceId: "workspace-intent",
};

function contract(objective = "Apply one idempotent mutation"): GovernorTaskContract {
  return {
    objective,
    constraints: [],
    knownFacts: [],
    unknowns: ["final state"],
    completionCriteria: [
      { criterionId: "verified", description: "Mutation is externally verified", mandatory: true },
    ],
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: ["synthetic.mutate"],
      canonicalTargets: ["fixture://target"],
    },
  };
}

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "mutate",
      description: "Apply the idempotent mutation",
      criterionIds: ["verified"],
      dependsOn: [],
    },
  ],
};

function registry() {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.mutate",
      version: "7",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
  ]);
}

function proposal(effectId: ReturnType<typeof createGovernorEffectId>) {
  return {
    effectId,
    criterionId: "verified",
    capability: "synthetic.mutate",
    capabilityVersion: "7",
    canonicalTarget: "fixture://target",
    expectedEvidence: "Exact post-mutation state",
    sourceRank: "structured_exact" as const,
    stopCondition: "State is verified",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ target: "fixture://target", value: true }),
    approvalGrantId: "approval-1",
  };
}

async function withIntentController(
  run: (params: {
    controller: GovernorController;
    broker: ReturnType<typeof createGovernorTestStore>["broker"];
    store: GovernorSqliteStore;
    stateDir: string;
  }) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-intent-" },
    async (state) => {
      const capabilities = registry();
      const { store, broker } = createGovernorTestStore({
        stateDir: state.stateDir,
        capabilities,
      });
      try {
        await run({
          controller: new GovernorController(store, capabilities),
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

function start(controller: GovernorController) {
  const taskId = controller.ingest({
    sourceMessageId: "intent-message-1",
    sourceSequence: 1,
    scope,
    mode: "FOCUSED",
    contract: contract(),
    now: 100,
  }).task.taskId;
  controller.preparePlan({ taskId, plan, now: 110 });
  controller.startExecution(taskId, 120);
  return taskId;
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor durable action intents", () => {
  it("deduplicates twenty reservations and crash recovery into one mutation and one effect", async () => {
    await withIntentController(({ controller, store, stateDir, broker }) => {
      const taskId = start(controller);
      const executionFence = controller.captureExecutionFence(taskId);
      const effectId = createGovernorEffectId("stable-mutation");
      const reservations = Array.from({ length: 20 }, (_, index) =>
        controller.admitAction({
          taskId,
          executionFence,
          proposal: proposal(effectId),
          progressVector: { desired: true, requestId: `volatile-${index}` },
          now: 121 + index,
        }),
      );
      expect(reservations.every((reservation) => reservation.accepted)).toBe(true);
      const admitted = reservations[0];
      if (!admitted?.accepted) {
        throw new Error("expected durable action reservation");
      }
      expect(
        new Set(
          reservations.map(
            (reservation) => reservation.accepted && reservation.intent.idempotencyKey,
          ),
        ).size,
      ).toBe(1);
      expect(store.actionIntents.listPendingIds(taskId, 1)).toEqual([effectId]);
      expect(
        store.listEvents(taskId).filter((event) => event.eventType === "action_admitted"),
      ).toHaveLength(1);

      closeOpenClawStateDatabase();
      const capabilities = registry();
      const restartedStore = new GovernorSqliteStore({
        stateDir,
        receiptResolver: broker.resolver,
        approvalResolver: broker.approvalResolver,
        deliveryResolver: broker.deliveryResolver,
        capabilities,
      });
      const restarted = new GovernorController(restartedStore, capabilities);
      expect(restarted.isActionIntentExecutable(admitted.intent)).toBe(true);
      const claims = Array.from({ length: 20 }, (_, index) =>
        restarted.claimActionIntent({
          intent: admitted.intent,
          workerId: `worker-${index}`,
          now: 180,
        }),
      );
      expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
      expect(claims.filter((claim) => claim.kind === "busy")).toHaveLength(19);
      const claim = claims.find((candidate) => candidate.kind === "claimed");
      if (!claim || claim.kind !== "claimed") {
        throw new Error("expected one action execution claim");
      }

      const observableMutations = new Map<string, { applied: true }>();
      const mutate = vi.fn((idempotencyKey: string) => {
        const prior = observableMutations.get(idempotencyKey);
        if (prior) {
          return prior;
        }
        const result = { applied: true } as const;
        observableMutations.set(idempotencyKey, result);
        return result;
      });
      mutate(claim.intent.idempotencyKey);
      const records = Array.from({ length: 20 }, (_, index) =>
        recordGovernorTestAdmittedToolOutcome(restarted, broker, {
          taskId,
          intent: claim.intent,
          workerId: "worker-0",
          claimEpoch: claim.intent.claimEpoch,
          outcome: {
            transport: "completed",
            semantic: "success",
            sideEffect: "applied",
            verification: "verified",
            summaryCode: "verified",
            evidence: { exactState: true },
          },
          now: 200 + index,
        }),
      );
      expect(records.every((record) => record.accepted)).toBe(true);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(observableMutations.size).toBe(1);
      expect(restartedStore.listEffects(taskId)).toHaveLength(1);
      expect(restartedStore.actionIntents.listPendingIds(taskId, 1)).toEqual([]);
      expect(
        restartedStore
          .listEvents(taskId)
          .filter((event) => event.eventType === "tool_outcome_recorded"),
      ).toHaveLength(1);
    });
  });

  it("invalidates a queued privileged action when a correction advances the objective", async () => {
    await withIntentController(({ controller, store }) => {
      const taskId = start(controller);
      const admission = controller.admitAction({
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: proposal(createGovernorEffectId("corrected-away")),
        progressVector: { desired: true },
        now: 121,
      });
      if (!admission.accepted) {
        throw new Error("expected action admission");
      }
      controller.ingest({
        sourceMessageId: "intent-message-2",
        sourceSequence: 2,
        scope,
        mode: "FOCUSED",
        contract: contract("Superseding objective"),
        now: 122,
      });
      expect(controller.isActionIntentExecutable(admission.intent)).toBe(false);
      expect(
        controller.recordAdmittedToolOutcome({
          taskId,
          intent: admission.intent,
          workerId: "late-worker",
          claimEpoch: admission.intent.claimEpoch,
          outcome: {
            transport: "completed",
            semantic: "success",
            sideEffect: "applied",
            verification: "verified",
            summaryCode: "late",
          },
          now: 123,
        }),
      ).toMatchObject({ accepted: false, reason: "stale_execution" });
      expect(store.listEffects(taskId)).toEqual([]);
      expect(store.listEvents(taskId).at(-1)?.eventType).toBe("late_tool_result_ignored");
    });
  });

  it("resumes the same durable checkpoint under a new task lease and execution generation", async () => {
    await withIntentController(({ controller, store }) => {
      const taskId = start(controller);
      controller.recordCheckpoint({
        taskId,
        checkpointId: "checkpoint-before-reclaim",
        verifiedFacts: [
          { claim: "Synthetic state is ready", evidenceDigest: governorDigest({ ready: true }) },
        ],
        discardedAssumptions: ["State was unavailable"],
        unresolvedQuestions: ["Will the worker survive takeover?"],
        competingHypotheses: ["Old worker returns", "New worker resumes"],
        nextDiscriminatingAction: "Reclaim the task lease",
        now: 120,
      });
      expect(store.checkpoints.list(taskId)).toHaveLength(1);
      const oldFence = controller.captureExecutionFence(taskId);
      const oldAdmission = controller.admitAction({
        taskId,
        executionFence: oldFence,
        proposal: proposal(createGovernorEffectId("pre-reclaim")),
        progressVector: { checkpoint: "ready" },
        now: 121,
      });
      if (!oldAdmission.accepted) {
        throw new Error("expected old action admission");
      }
      const before = store.loadTask(taskId);
      if (!before) {
        throw new Error("missing task before reclaim");
      }
      const reclaimed = controller.reclaimTaskLease({
        taskId,
        expectedTaskVersion: before.taskVersion,
        expectedLeaseEpoch: before.leaseEpoch,
        now: 122,
      });
      expect(reclaimed).toMatchObject({
        taskId,
        state: "EXECUTING",
        leaseEpoch: before.leaseEpoch + 1,
        executionGeneration: before.executionGeneration + 1,
        planVersion: before.planVersion,
      });
      expect(controller.isActionIntentExecutable(oldAdmission.intent)).toBe(false);
      expect(
        controller.claimActionIntent({
          intent: oldAdmission.intent,
          workerId: "stale-worker",
          now: 123,
        }).kind,
      ).toBe("stale_worker");
      const resumed = controller.admitAction({
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: proposal(createGovernorEffectId("post-reclaim")),
        progressVector: { checkpoint: "ready", generation: 1 },
        now: 124,
      });
      expect(resumed.accepted).toBe(true);
      expect(store.listEvents(taskId).at(-2)?.eventType).toBe("lease_reclaimed");
      expect(store.loadTask(taskId)?.taskId).toBe(taskId);
    });
  });
});
