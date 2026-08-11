// Proves the first durable governor slice from ingress through exactly-once delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore, recordGovernorTestToolOutcome } from "./test-broker.js";
import {
  createGovernorEffectId,
  type GovernorPlan,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-a",
  channel: "synthetic",
  accountId: "account-a",
  conversationId: "conversation-a",
  sessionId: "session-a",
  agentId: "agent-a",
  workspaceId: "workspace-a",
};

function contract(objective: string): GovernorTaskContract {
  return {
    objective,
    constraints: ["Use only synthetic evidence"],
    knownFacts: [],
    unknowns: ["current state"],
    completionCriteria: [
      { criterionId: "state-verified", description: "State is verified", mandatory: true },
    ],
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: [],
      canonicalTargets: [],
    },
  };
}

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "inspect",
      description: "Inspect exact synthetic state",
      criterionIds: ["state-verified"],
      dependsOn: [],
    },
  ],
};

function capabilities(): GovernorCapabilityRegistry {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.inventory",
      version: "1",
      sourceRank: "structured_exact",
      mutating: false,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
    {
      capability: "assistant.summary",
      version: "1",
      sourceRank: "broad_scan",
      mutating: false,
      canonicalTargetPrefixes: ["assistant://"],
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
    { layout: "state-only", prefix: "openclaw-governor-" },
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

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("durable behavior governor", () => {
  it("keeps corrections on one task and orders them by authenticated source sequence", async () => {
    await withGovernor(({ controller, store }) => {
      const first = controller.ingest({
        sourceMessageId: "message-1",
        sourceSequence: 1,
        scope,
        mode: "FOCUSED",
        contract: contract("Initial objective"),
        now: 100,
      });
      const newest = controller.ingest({
        sourceMessageId: "message-3",
        sourceSequence: 3,
        scope,
        mode: "DEEP",
        contract: contract("Corrected objective"),
        now: 102,
      });
      const lateOlder = controller.ingest({
        sourceMessageId: "message-2",
        sourceSequence: 2,
        scope,
        mode: "FOCUSED",
        contract: contract("Stale objective"),
        now: 103,
      });
      const duplicates = Array.from({ length: 20 }, (_, index) =>
        controller.ingest({
          sourceMessageId: "message-3",
          sourceSequence: 3,
          scope,
          mode: "DEEP",
          contract: contract("Corrected objective"),
          now: 104 + index,
        }),
      );

      expect([
        first.task.taskId,
        newest.task.taskId,
        lateOlder.task.taskId,
        ...duplicates.map((item) => item.task.taskId),
      ]).toEqual(Array.from({ length: 23 }, () => first.task.taskId));
      expect(newest.kind).toBe("corrected");
      expect(lateOlder.kind).toBe("stale");
      expect(duplicates.every((item) => item.kind === "duplicate")).toBe(true);
      expect(store.loadTask(first.task.taskId)).toMatchObject({
        objectiveRevision: 2,
        authenticatedSourceSequence: 3,
        mode: "DEEP",
        contract: { objective: "Corrected objective" },
      });
      expect(store.listEvents(first.task.taskId).map((event) => event.eventType)).toEqual([
        "task_received",
        "task_corrected",
        "stale_ingress_ignored",
      ]);
    });
  });

  it("rejects semantic failure, recovers with new evidence, and emits one completion", async () => {
    await withGovernor(async ({ controller, store, stateDir, broker }) => {
      const ingress = controller.ingest({
        sourceMessageId: "message-1",
        sourceSequence: 1,
        scope,
        mode: "DEEP",
        contract: contract("Verify durable state"),
        now: 100,
      });
      const taskId = ingress.task.taskId;
      controller.preparePlan({ taskId, plan, now: 110 });
      controller.startExecution(taskId, 120);
      controller.recordToolOutcome({
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("first-inspection"),
          criterionId: "state-verified",
          capability: "synthetic.inventory",
          capabilityVersion: "1",
          canonicalTarget: "fixture://state",
          expectedEvidence: "An exact state record",
          sourceRank: "structured_exact",
          stopCondition: "State record found",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({ target: "state" }),
        },
        progressVector: { verifiedCriteria: [] },
        outcome: {
          transport: "completed",
          semantic: "not_found",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "missing",
        },
        now: 121,
      });
      controller.beginVerification(taskId, 122);
      const rejected = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 123,
      });
      expect(rejected.completed).toBe(false);
      if (rejected.completed) {
        throw new Error("expected rejected finish");
      }
      expect(rejected.recovery).toMatchObject({
        unmetCriteria: ["state-verified"],
        semanticFailures: [expect.stringContaining(":not_found")],
      });

      controller.preparePlan({ taskId, plan, now: 130 });
      controller.startExecution(taskId, 140);
      const successfulOutcome: Parameters<GovernorController["recordToolOutcome"]>[0] = {
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("second-inspection"),
          criterionId: "state-verified",
          capability: "synthetic.inventory",
          capabilityVersion: "1",
          canonicalTarget: "fixture://state",
          expectedEvidence: "An exact state record",
          sourceRank: "structured_exact",
          stopCondition: "State record found",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({ target: "state", attempt: 2 }),
        },
        progressVector: { verifiedCriteria: ["state-verified"] },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "found",
          evidence: { state: "healthy" },
        },
        now: 141,
      };
      const firstSuccess = recordGovernorTestToolOutcome(controller, broker, successfulOutcome);
      expect(firstSuccess.accepted).toBe(true);
      if (!firstSuccess.accepted) {
        throw new Error(firstSuccess.reason);
      }
      const versionAfterSuccess = firstSuccess.task.taskVersion;
      const duplicateSuccess = recordGovernorTestToolOutcome(controller, broker, successfulOutcome);
      expect(duplicateSuccess.accepted).toBe(true);
      if (!duplicateSuccess.accepted) {
        throw new Error(duplicateSuccess.reason);
      }
      expect(duplicateSuccess.task.taskVersion).toBe(versionAfterSuccess);
      expect(store.listEffects(taskId)).toHaveLength(2);
      controller.beginVerification(taskId, 142);
      const completed = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 143,
      });
      expect(completed.completed).toBe(true);
      if (!completed.completed) {
        throw new Error("expected completed finish");
      }
      expect(store.outbox.list(taskId)).toHaveLength(1);
      expect(store.listEvents(taskId).at(-1)?.payload).toMatchObject({
        objectiveRevision: completed.certificate.objectiveRevision,
        planVersion: completed.certificate.planVersion,
        executionGeneration: completed.certificate.executionGeneration,
        evidenceDigests: completed.certificate.evidenceDigests,
      });

      closeOpenClawStateDatabase();
      const { store: restartedStore, broker: restartedBroker } = createGovernorTestStore({
        stateDir,
      });
      const restarted = new GovernorController(restartedStore, capabilities());
      expect(restartedStore.loadTask(taskId)).toMatchObject({ state: "COMPLETED" });
      expect(restartedStore.outbox.list(taskId)).toHaveLength(1);

      const providerAttempts: string[] = [];
      const observableDeliveries: string[] = [];
      const send = vi.fn(async ({ deliveryKey }: { deliveryKey: string }) => {
        providerAttempts.push(deliveryKey);
        if (!observableDeliveries.includes(deliveryKey)) {
          observableDeliveries.push(deliveryKey);
        }
        return {
          deliveryKey,
          receipt: { providerId: "delivery-1" },
        };
      });
      const effectId = restartedStore.outbox.list(taskId)[0]?.effectId;
      if (!effectId) {
        throw new Error("missing completion effect");
      }
      const unsupportedSend = vi.fn();
      const adapter = {
        send,
      };
      await expect(
        restarted.dispatchOutbox({
          taskId,
          effectId,
          expectedLeaseEpoch: completed.task.leaseEpoch,
          workerId: "unsupported-delivery-worker",
          adapterHandle: "unregistered",
          now: 149,
        }),
      ).rejects.toThrow(/host-registered/);
      expect(unsupportedSend).not.toHaveBeenCalled();
      expect(restartedStore.outbox.list(taskId)[0]).toMatchObject({ state: "pending" });
      const adapterHandle = restartedBroker.capabilities.registerStaticDeliveryAdapter({
        identity: { adapterId: "synthetic", version: "1", capability: "message.send" },
        config: { fixture: "controller" },
        generation: 0,
        factory: () => adapter,
      });
      await restarted.dispatchOutbox({
        taskId,
        effectId,
        expectedLeaseEpoch: completed.task.leaseEpoch,
        workerId: "delivery-worker-1",
        adapterHandle,
        now: 150,
      });
      const replay = await restarted.dispatchOutbox({
        taskId,
        effectId,
        expectedLeaseEpoch: completed.task.leaseEpoch,
        workerId: "delivery-worker-2",
        adapterHandle,
        now: 151,
      });
      expect(replay.kind).toBe("already_sent");
      expect(send).toHaveBeenCalledTimes(1);
      expect(providerAttempts).toHaveLength(1);
      expect(observableDeliveries).toHaveLength(1);
    });
  });

  it("does not admit assistant text as evidence", async () => {
    await withGovernor(({ controller }) => {
      const taskId = controller.ingest({
        sourceMessageId: "message-1",
        sourceSequence: 1,
        scope,
        mode: "FOCUSED",
        contract: contract("Reject self-authored evidence"),
        now: 100,
      }).task.taskId;
      controller.preparePlan({ taskId, plan, now: 110 });
      controller.startExecution(taskId, 120);
      const result = controller.recordToolOutcome({
        taskId,
        executionFence: controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId("assistant-claim"),
          criterionId: "state-verified",
          capability: "assistant.summary",
          capabilityVersion: "1",
          canonicalTarget: "assistant://self",
          expectedEvidence: "A claim",
          sourceRank: "broad_scan",
          stopCondition: "Claim emitted",
          mutating: false,
          argumentsDigest: governorArgumentsDigest({}),
        },
        progressVector: { verifiedCriteria: [] },
        outcome: {
          transport: "completed",
          semantic: "success",
          sideEffect: "not_applicable",
          verification: "not_required",
          summaryCode: "claimed",
          evidence: { state: "healthy" },
        },
        evidenceSourceKind: "assistant_text",
        now: 121,
      });
      expect(result.accepted).toBe(true);
      if (!result.accepted) {
        throw new Error(result.reason);
      }
      expect(result.evidence).toBeUndefined();
      controller.beginVerification(taskId, 122);
      const finish = controller.proposeFinish({
        taskId,
        response: { framing: "summary", materialClaimIds: [] },
        now: 123,
      });
      expect(finish).toMatchObject({
        completed: false,
        recovery: { unmetCriteria: ["state-verified"] },
      });
    });
  });
});
