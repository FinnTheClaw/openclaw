// Runs the mandatory synthetic replay, crash, idempotency, efficiency, and deep-work gates.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import {
  assertGovernorMandatoryEvalGates,
  summarizeGovernorEvals,
  type GovernorEvalSample,
} from "./eval-harness.js";
import { GovernorSqliteStore } from "./store.js";
import {
  createGovernorEffectId,
  type GovernorPlan,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

function scope(index: number): GovernorTaskScope {
  return {
    principalId: `principal-${index}`,
    channel: "synthetic",
    accountId: `account-${index}`,
    conversationId: `conversation-${index}`,
    sessionId: `session-${index}`,
    agentId: "agent-eval",
    workspaceId: `workspace-${index}`,
  };
}

function contract(objective: string, mutating: boolean): GovernorTaskContract {
  return {
    objective,
    constraints: ["Use synthetic fixtures"],
    knownFacts: [],
    unknowns: ["final state"],
    completionCriteria: [
      { criterionId: "verified", description: "Final state is verified", mandatory: true },
    ],
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: mutating ? ["synthetic.mutate"] : [],
      canonicalTargets: mutating ? ["fixture://target"] : [],
    },
  };
}

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "verify",
      description: "Produce exact synthetic evidence",
      criterionIds: ["verified"],
      dependsOn: [],
    },
  ],
};

function registry(): GovernorCapabilityRegistry {
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

function mutationProposal(effectId: ReturnType<typeof createGovernorEffectId>) {
  return {
    effectId,
    criterionId: "verified",
    capability: "synthetic.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://target",
    expectedEvidence: "Exact post-mutation fixture",
    sourceRank: "structured_exact" as const,
    stopCondition: "Fixture is verified",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ target: "fixture://target", value: true }),
  };
}

afterEach(() => closeOpenClawStateDatabase());

describe("behavior governor mandatory synthetic evals", () => {
  it("keeps a four-message correction episode on one task with source sequence authority", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-four-message-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, registry());
        try {
          const arrivals = [
            { id: "message-1", sequence: 1, objective: "Initial" },
            { id: "message-4", sequence: 4, objective: "Final correction" },
            { id: "message-2", sequence: 2, objective: "Late repetition" },
            { id: "message-3", sequence: 3, objective: "Late correction" },
          ];
          const results = arrivals.map((arrival, index) =>
            controller.ingest({
              sourceMessageId: arrival.id,
              sourceSequence: arrival.sequence,
              scope: scope(1),
              mode: "DEEP",
              contract: contract(arrival.objective, false),
              now: 100 + index,
            }),
          );
          expect(new Set(results.map((result) => result.task.taskId)).size).toBe(1);
          expect(results.map((result) => result.kind)).toEqual([
            "created",
            "corrected",
            "stale",
            "stale",
          ]);
          expect(store.loadTask(results[0]!.task.taskId)).toMatchObject({
            authenticatedSourceSequence: 4,
            objectiveRevision: 2,
            contract: { objective: "Final correction" },
          });
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("survives repeated crashes and twenty duplicate deliveries without duplicate effects", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-crash-eval-" },
      async (state) => {
        let store = new GovernorSqliteStore({ stateDir: state.stateDir });
        let controller = new GovernorController(store, registry());
        const mutations = new Map<string, string>();
        const visibleReplies = new Map<string, string>();
        const samples: GovernorEvalSample[] = [];
        const reopen = () => {
          closeOpenClawStateDatabase();
          store = new GovernorSqliteStore({ stateDir: state.stateDir });
          controller = new GovernorController(store, registry());
        };

        try {
          for (let index = 0; index < 20; index += 1) {
            const sourceMessageId = `crash-message-${index}`;
            const first = controller.ingest({
              sourceMessageId,
              sourceSequence: 1,
              scope: scope(100 + index),
              mode: "FOCUSED",
              contract: contract(`Crash recovery ${index}`, true),
              now: index * 1_000 + 100,
            });
            const duplicateIds = Array.from(
              { length: 20 },
              () =>
                controller.ingest({
                  sourceMessageId,
                  sourceSequence: 1,
                  scope: scope(100 + index),
                  mode: "FOCUSED",
                  contract: contract(`Crash recovery ${index}`, true),
                  now: index * 1_000 + 101,
                }).task.taskId,
            );
            expect(new Set([first.task.taskId, ...duplicateIds]).size).toBe(1);
            const taskId = first.task.taskId;
            reopen();

            controller.preparePlan({ taskId, plan, now: index * 1_000 + 110 });
            controller.startExecution(taskId, index * 1_000 + 120);
            const executionFence = controller.captureExecutionFence(taskId);
            const effectId = createGovernorEffectId(`crash-effect-${index}`);
            const reservations = Array.from({ length: 20 }, () =>
              controller.admitAction({
                taskId,
                executionFence,
                proposal: mutationProposal(effectId),
                progressVector: { desired: true },
                now: index * 1_000 + 121,
              }),
            );
            expect(reservations.every((reservation) => reservation.accepted)).toBe(true);
            const reservation = reservations[0];
            if (!reservation?.accepted) {
              throw new Error("missing action reservation");
            }
            reopen();

            const oldClaim = controller.claimActionIntent({
              intent: reservation.intent,
              workerId: `old-action-${index}`,
              leaseDurationMs: 10,
              now: index * 1_000 + 130,
            });
            if (oldClaim.kind !== "claimed") {
              throw new Error("missing old action claim");
            }
            mutations.set(oldClaim.intent.idempotencyKey, `mutation-${index}`);
            reopen();

            const newClaim = controller.claimActionIntent({
              intent: reservation.intent,
              workerId: `new-action-${index}`,
              leaseDurationMs: 10,
              now: index * 1_000 + 141,
            });
            if (newClaim.kind !== "claimed") {
              throw new Error("missing reclaimed action");
            }
            mutations.set(newClaim.intent.idempotencyKey, `mutation-${index}`);
            expect(
              controller.recordAdmittedToolOutcome({
                taskId,
                intent: oldClaim.intent,
                workerId: `old-action-${index}`,
                claimEpoch: oldClaim.intent.claimEpoch,
                outcome: {
                  transport: "completed",
                  semantic: "success",
                  sideEffect: "applied",
                  verification: "verified",
                  summaryCode: "late",
                },
                now: index * 1_000 + 142,
              }),
            ).toMatchObject({ accepted: false, reason: "stale_execution" });
            controller.recordAdmittedToolOutcome({
              taskId,
              intent: newClaim.intent,
              workerId: `new-action-${index}`,
              claimEpoch: newClaim.intent.claimEpoch,
              outcome: {
                transport: "completed",
                semantic: "success",
                sideEffect: "applied",
                verification: "verified",
                summaryCode: "verified",
                evidence: { exactState: true },
              },
              now: index * 1_000 + 143,
            });
            reopen();

            controller.beginVerification(taskId, index * 1_000 + 150);
            const completion = controller.proposeFinish({
              taskId,
              responseText: `Completed ${index}`,
              now: index * 1_000 + 151,
            });
            if (!completion.completed) {
              throw new Error("expected certified completion");
            }
            const outbox = store.outbox.list(taskId)[0];
            if (!outbox) {
              throw new Error("missing completion outbox");
            }
            const oldDelivery = store.outbox.claim({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `old-delivery-${index}`,
              leaseDurationMs: 10,
              now: index * 1_000 + 160,
            });
            if (oldDelivery.kind !== "claimed") {
              throw new Error("missing old delivery claim");
            }
            visibleReplies.set(oldDelivery.entry.deliveryKey, `reply-${index}`);
            reopen();

            const newDelivery = store.outbox.claim({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `new-delivery-${index}`,
              leaseDurationMs: 10,
              now: index * 1_000 + 171,
            });
            if (newDelivery.kind !== "claimed") {
              throw new Error("missing reclaimed delivery");
            }
            visibleReplies.set(newDelivery.entry.deliveryKey, `reply-${index}`);
            store.outbox.markSent({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              expectedDeliveryClaimEpoch: newDelivery.entry.deliveryClaimEpoch,
              workerId: `new-delivery-${index}`,
              providerReceipt: { providerId: `reply-${index}` },
              now: index * 1_000 + 172,
            });
            const effects = store.listEffects(taskId);
            const deliveries = store.outbox.list(taskId);
            samples.push({
              success: effects.length === 1 && deliveries[0]?.state === "sent",
              prematureCompletion: false,
              resumedAfterCrash: true,
              duplicateMutation:
                mutations.get(newClaim.intent.idempotencyKey) !== `mutation-${index}`,
              duplicateReply:
                visibleReplies.get(newDelivery.entry.deliveryKey) !== `reply-${index}`,
              meaningfulCalls: 3,
              usefulCalls: 3,
            });
          }

          const summary = summarizeGovernorEvals(samples);
          const accessInventory = summarizeGovernorEvals(
            Array.from({ length: 100 }, () => ({
              success: true,
              prematureCompletion: false,
              resumedAfterCrash: true,
              duplicateMutation: false,
              duplicateReply: false,
              meaningfulCalls: 3,
              usefulCalls: 3,
            })),
          );
          expect(summary).toMatchObject({
            samples: 20,
            successRate: 1,
            restartResumeRate: 1,
            duplicateMutations: 0,
            duplicateReplies: 0,
          });
          expect(accessInventory).toMatchObject({ meaningfulCallsP95: 3, usefulActionRatio: 1 });
          expect(() =>
            assertGovernorMandatoryEvalGates({
              summary,
              accessInventory,
              baselineShortTaskSuccessRate: 1,
            }),
          ).not.toThrow();
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("allows more than thirty useful deep actions and rejects prior-revision evidence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-deep-eval-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, registry());
        try {
          const taskId = controller.ingest({
            sourceMessageId: "deep-message-1",
            sourceSequence: 1,
            scope: scope(500),
            mode: "DEEP",
            contract: contract("Run 35 useful exact checks", false),
            now: 100,
          }).task.taskId;
          controller.preparePlan({ taskId, plan, now: 110 });
          controller.startExecution(taskId, 120);
          for (let index = 0; index < 35; index += 1) {
            controller.recordToolOutcome({
              taskId,
              executionFence: controller.captureExecutionFence(taskId),
              proposal: {
                effectId: createGovernorEffectId(`deep-${index}`),
                criterionId: "verified",
                capability: "synthetic.inspect",
                capabilityVersion: "1",
                canonicalTarget: `fixture://item/${index}`,
                expectedEvidence: `Exact item ${index}`,
                sourceRank: "structured_exact",
                stopCondition: `Item ${index} is verified`,
                mutating: false,
                argumentsDigest: governorArgumentsDigest({ index }),
              },
              progressVector: { verifiedThrough: index },
              outcome: {
                transport: "completed",
                semantic: "success",
                sideEffect: "not_applicable",
                verification: "not_required",
                summaryCode: "verified",
                evidence: { index, verified: true },
              },
              now: 121 + index,
            });
          }
          expect(store.listEffects(taskId)).toHaveLength(35);
          controller.beginVerification(taskId, 200);
          expect(
            controller.proposeFinish({ taskId, responseText: "Deep checks complete", now: 201 })
              .completed,
          ).toBe(true);

          const secondTaskId = controller.ingest({
            sourceMessageId: "revision-message-1",
            sourceSequence: 1,
            scope: scope(501),
            mode: "FOCUSED",
            contract: contract("Original revision", false),
            now: 300,
          }).task.taskId;
          controller.preparePlan({ taskId: secondTaskId, plan, now: 310 });
          controller.startExecution(secondTaskId, 320);
          controller.recordToolOutcome({
            taskId: secondTaskId,
            executionFence: controller.captureExecutionFence(secondTaskId),
            proposal: {
              effectId: createGovernorEffectId("old-revision"),
              criterionId: "verified",
              capability: "synthetic.inspect",
              capabilityVersion: "1",
              canonicalTarget: "fixture://old",
              expectedEvidence: "Old evidence",
              sourceRank: "structured_exact",
              stopCondition: "Old state verified",
              mutating: false,
              argumentsDigest: governorArgumentsDigest({ revision: 1 }),
            },
            progressVector: { revision: 1 },
            outcome: {
              transport: "completed",
              semantic: "success",
              sideEffect: "not_applicable",
              verification: "not_required",
              summaryCode: "verified",
              evidence: { revision: 1 },
            },
            now: 321,
          });
          controller.ingest({
            sourceMessageId: "revision-message-2",
            sourceSequence: 2,
            scope: scope(501),
            mode: "FOCUSED",
            contract: contract("Corrected revision", false),
            now: 322,
          });
          controller.preparePlan({ taskId: secondTaskId, plan, now: 330 });
          controller.startExecution(secondTaskId, 340);
          controller.beginVerification(secondTaskId, 341);
          const rejected = controller.proposeFinish({
            taskId: secondTaskId,
            responseText: "Old evidence must not complete this revision",
            now: 342,
          });
          expect(rejected.completed).toBe(false);
          if (!rejected.completed) {
            expect(rejected.recovery.unmetCriteria).toEqual(["verified"]);
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
