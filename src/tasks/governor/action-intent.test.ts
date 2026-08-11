// Proves pre-execution durability, stable idempotency, and correction fences for tool actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
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
      requiresApproval: true,
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
    approvalGrant: {
      grantId: "approval-1",
      objectiveRevision: 1,
      capabilityVersion: "7",
      canonicalTarget: "fixture://target",
    },
  };
}

async function withIntentController(
  run: (params: {
    controller: GovernorController;
    store: GovernorSqliteStore;
    stateDir: string;
  }) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-intent-" },
    async (state) => {
      const store = new GovernorSqliteStore({ stateDir: state.stateDir });
      try {
        await run({
          controller: new GovernorController(store, registry()),
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
    await withIntentController(({ controller, store, stateDir }) => {
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
      const restartedStore = new GovernorSqliteStore({ stateDir });
      const restarted = new GovernorController(restartedStore, registry());
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
        restarted.recordAdmittedToolOutcome({
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
});
