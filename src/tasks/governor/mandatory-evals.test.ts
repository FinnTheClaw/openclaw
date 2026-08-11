// Runs the mandatory synthetic replay, crash, idempotency, efficiency, and deep-work gates.
import { afterEach, describe, expect, it } from "vitest";
import {
  getSyntheticHostDeliveryAttempts,
  getSyntheticHostObservableSends,
  recordSyntheticAcceptedSend,
  resetSyntheticHostDeliveryAttempts,
} from "../../security/governor-host-delivery-implementations.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import {
  assertGovernorMandatoryEvalGates,
  summarizeGovernorEvals,
  type GovernorEvalSample,
} from "./eval-harness.js";
import {
  countGovernorObservedKey,
  createMandatoryEvalMutationProposal,
  ObservedMutationAdapter,
} from "./mandatory-eval-adapters.js";
import { reconcileMandatoryUnknownMutation } from "./mandatory-eval-crash-helpers.js";
import {
  createMandatoryEvalRegistry,
  mandatoryEvalContract,
  mandatoryEvalPlan,
  mandatoryEvalScope,
} from "./mandatory-eval-fixtures.js";
import { GovernorRuntimeAdapter } from "./runtime-adapter.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore, recordGovernorTestToolOutcome } from "./test-broker.js";
import { createGovernorEffectId } from "./types.js";

function registerMandatorySyntheticDelivery(
  capabilities: ReturnType<typeof createGovernorTestStore>["broker"]["capabilities"],
  observerKey: string,
) {
  return capabilities.registerStaticDeliveryAdapter({
    implementationId: "synthetic",
    config: { fixture: "mandatory-eval", observerKey },
    generation: 0,
  });
}

afterEach(() => {
  closeOpenClawStateDatabase();
  resetSyntheticHostDeliveryAttempts("test");
});

describe("behavior governor mandatory synthetic evals", () => {
  it("keeps a four-message correction episode on one task with source sequence authority", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-four-message-" },
      async (state) => {
        const capabilities = createMandatoryEvalRegistry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
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
              scope: mandatoryEvalScope(1),
              mode: "DEEP",
              contract: mandatoryEvalContract(arrival.objective, false),
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

  it("observes duplicate, crash, access, and short-task gates from deterministic executions", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-crash-eval-" },
      async (state) => {
        let capabilities = createMandatoryEvalRegistry();
        let testHost = createGovernorTestStore({
          stateDir: state.stateDir,
          capabilities,
        });
        let store = testHost.store;
        let controller = new GovernorController(store, capabilities);
        const mutationAdapter = new ObservedMutationAdapter();
        const deliveryObserverKey = "mandatory-eval";
        resetSyntheticHostDeliveryAttempts("test", deliveryObserverKey);
        let deliveryHandle = registerMandatorySyntheticDelivery(
          testHost.broker.capabilities,
          deliveryObserverKey,
        );
        const samples: GovernorEvalSample[] = [];
        const accessSamples: GovernorEvalSample[] = [];
        const crashCheckpoints = new Set<string>();
        const reopen = (checkpoint: string) => {
          crashCheckpoints.add(checkpoint);
          closeOpenClawStateDatabase();
          capabilities = createMandatoryEvalRegistry();
          testHost = createGovernorTestStore({
            stateDir: state.stateDir,
            capabilities,
          });
          store = testHost.store;
          controller = new GovernorController(store, capabilities);
          deliveryHandle = registerMandatorySyntheticDelivery(
            testHost.broker.capabilities,
            deliveryObserverKey,
          );
        };

        try {
          for (let index = 0; index < 20; index += 1) {
            const base = index * 1_000;
            const sourceMessageId = `crash-message-${index}`;
            const first = controller.ingest({
              sourceMessageId,
              sourceSequence: 1,
              scope: mandatoryEvalScope(100 + index),
              mode: "FOCUSED",
              contract: mandatoryEvalContract(`Crash recovery ${index}`, true),
              now: base + 100,
            });
            const duplicateIds = await Promise.all(
              Array.from(
                { length: 20 },
                async () =>
                  controller.ingest({
                    sourceMessageId,
                    sourceSequence: 1,
                    scope: mandatoryEvalScope(100 + index),
                    mode: "FOCUSED",
                    contract: mandatoryEvalContract(`Crash recovery ${index}`, true),
                    now: base + 101,
                  }).task.taskId,
              ),
            );
            expect(new Set([first.task.taskId, ...duplicateIds]).size).toBe(1);
            const taskId = first.task.taskId;
            reopen("after_ingress");

            controller.preparePlan({ taskId, plan: mandatoryEvalPlan, now: base + 110 });
            controller.startExecution(taskId, base + 120);
            reopen("after_plan_and_start");

            const accessCalls: Array<{ accepted: boolean; semantic?: string }> = [];
            for (let operation = 0; operation < 3; operation += 1) {
              const evidence = { index, operation, found: true };
              const outcome = recordGovernorTestToolOutcome(controller, testHost.broker, {
                taskId,
                executionFence: controller.captureExecutionFence(taskId),
                proposal: {
                  effectId: createGovernorEffectId(`inventory-${index}-${operation}`),
                  criterionId: "verified",
                  capability: "synthetic.inspect",
                  capabilityVersion: "1",
                  canonicalTarget: `fixture://inventory/${index}/${operation}`,
                  expectedEvidence: "Exact structured inventory row",
                  sourceRank: "structured_exact",
                  stopCondition: "Inventory row is present",
                  mutating: false,
                  argumentsDigest: governorArgumentsDigest({ index, operation }),
                },
                progressVector: { index, operation },
                outcome: {
                  transport: "completed",
                  semantic: "success",
                  sideEffect: "not_applicable",
                  verification: "not_required",
                  summaryCode: "inventory_row",
                  evidence,
                },
                now: base + 121 + operation,
              });
              accessCalls.push({
                accepted: outcome.accepted,
                ...(outcome.accepted ? { semantic: outcome.effect.outcome.semantic } : {}),
              });
            }
            accessSamples.push({
              success: accessCalls.every((call) => call.accepted && call.semantic === "success"),
              prematureCompletion: false,
              resumedAfterCrash: true,
              duplicateMutation: false,
              duplicateReply: false,
              meaningfulCalls: accessCalls.length,
              usefulCalls: accessCalls.filter(
                (call) => call.accepted && call.semantic === "success",
              ).length,
            });

            const executionFence = controller.captureExecutionFence(taskId);
            const effectId = createGovernorEffectId(`crash-effect-${index}`);
            const reservations = Array.from({ length: 20 }, () =>
              controller.admitAction({
                taskId,
                executionFence,
                proposal: createMandatoryEvalMutationProposal(effectId),
                progressVector: { desired: true },
                now: base + 125,
              }),
            );
            expect(reservations.every((reservation) => reservation.accepted)).toBe(true);
            const reservation = reservations[0];
            if (!reservation?.accepted) {
              throw new Error("missing action reservation");
            }
            reopen("after_action_reservation");

            const oldClaim = controller.claimActionIntent({
              intent: reservation.intent,
              workerId: `old-action-${index}`,
              leaseDurationMs: 10,
              now: base + 130,
            });
            if (oldClaim.kind !== "claimed") {
              throw new Error("missing old action claim");
            }
            const oldStarted = controller.beginActionEffect({
              intent: oldClaim.intent,
              workerId: `old-action-${index}`,
              claimEpoch: oldClaim.intent.claimEpoch,
              now: base + 130,
            });
            if (oldStarted.kind !== "started") {
              throw new Error("missing old action effect fence");
            }
            mutationAdapter.apply(oldStarted.intent.idempotencyKey);
            reopen("after_mutation_provider_accept");

            const newClaim = controller.claimActionIntent({
              intent: reservation.intent,
              workerId: `new-action-${index}`,
              leaseDurationMs: 10,
              now: base + 141,
            });
            if (newClaim.kind !== "reconcile_required") {
              throw new Error("started action was incorrectly reclaimable");
            }
            expect(
              controller.recordAdmittedToolOutcome({
                taskId,
                intent: oldStarted.intent,
                workerId: `old-action-${index}`,
                claimEpoch: oldStarted.intent.claimEpoch,
                outcome: {
                  transport: "completed",
                  semantic: "success",
                  sideEffect: "applied",
                  verification: "verified",
                  summaryCode: "late",
                },
                now: base + 142,
              }),
            ).toMatchObject({ accepted: false, reason: "stale_execution" });
            const task = store.loadTask(taskId);
            if (!task) {
              throw new Error("missing task during action reconciliation");
            }
            reconcileMandatoryUnknownMutation({
              controller,
              capabilities: testHost.broker.capabilities,
              scopeKey: task.scopeKey,
              taskId,
              intent: newClaim.intent,
              observedAt: base + 143,
            });
            reopen("after_mutation_outcome");

            controller.beginVerification(taskId, base + 150);
            const completion = controller.proposeFinish({
              taskId,
              response: { framing: "summary", materialClaimIds: [] },
              now: base + 151,
            });
            if (!completion.completed) {
              throw new Error("expected certified completion");
            }
            const outbox = store.outbox.list(taskId)[0];
            if (!outbox) {
              throw new Error("missing completion outbox");
            }
            const certifiedDelivery = store.resolveCertifiedDelivery(deliveryHandle);
            const oldDelivery = store.outbox.claim({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `old-delivery-${index}`,
              leaseDurationMs: 10,
              now: base + 160,
              deliveryBinding: {
                adapterHandle: certifiedDelivery.handle,
                identityKey: certifiedDelivery.identityKey,
                implementationDigest: certifiedDelivery.implementationDigest,
                configDigest: certifiedDelivery.configDigest,
                generation: certifiedDelivery.generation,
                channel: certifiedDelivery.binding.channel,
                accountIdentity: certifiedDelivery.binding.accountIdentity,
                targetIdentity: certifiedDelivery.binding.targetIdentity,
                deploymentIdentity: certifiedDelivery.binding.deploymentIdentity,
              },
            });
            if (oldDelivery.kind !== "claimed") {
              throw new Error("missing old delivery claim");
            }
            recordSyntheticAcceptedSend("test", deliveryObserverKey, oldDelivery.entry.deliveryKey);
            reopen("after_delivery_provider_accept");
            await controller.dispatchOutbox({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `new-delivery-${index}`,
              leaseDurationMs: 10,
              adapterHandle: deliveryHandle,
              now: base + 171,
            });
            const mutationAttempts = mutationAdapter.attempts.filter(
              (key) => key === newClaim.intent.idempotencyKey,
            );
            const deliveryAttempts = getSyntheticHostDeliveryAttempts(
              "test",
              deliveryObserverKey,
            ).filter((key) => key === oldDelivery.entry.deliveryKey);
            const observableDeliveries = getSyntheticHostObservableSends(
              "test",
              deliveryObserverKey,
            );
            samples.push({
              success:
                store.listEffects(taskId).length === 3 &&
                store.outbox.list(taskId)[0]?.state === "sent",
              prematureCompletion: false,
              resumedAfterCrash: true,
              duplicateMutation:
                countGovernorObservedKey(
                  mutationAdapter.observableEffects,
                  newClaim.intent.idempotencyKey,
                ) > 1,
              duplicateReply:
                countGovernorObservedKey(observableDeliveries, oldDelivery.entry.deliveryKey) > 1,
              meaningfulCalls: mutationAttempts.length + deliveryAttempts.length,
              usefulCalls: 2,
            });
            expect(mutationAttempts).toHaveLength(1);
            expect(deliveryAttempts).toHaveLength(1);
            expect(
              countGovernorObservedKey(
                mutationAdapter.observableEffects,
                newClaim.intent.idempotencyKey,
              ),
            ).toBe(1);
            expect(
              countGovernorObservedKey(observableDeliveries, oldDelivery.entry.deliveryKey),
            ).toBe(1);
          }

          const quickProfile = {
            incident: false,
            effectful: false,
            requiresExternalEvidence: false,
            consequential: false,
            estimatedUsefulActions: 0,
            independentBranches: 0,
          } as const;
          const shortRuns = Array.from({ length: 20 }, (_, index) => {
            const runtime = new GovernorRuntimeAdapter(controller);
            const routed = runtime.routeIngress({
              sourceMessageId: `short-${index}`,
              sourceSequence: 1,
              scope: mandatoryEvalScope(500 + index),
              profile: quickProfile,
              contract: mandatoryEvalContract("Prompt-contained quick chat", false),
              now: 30_000 + index,
            });
            return routed.kind === "quick" && routed.decision.toolPolicy === "forbidden";
          });
          const summary = summarizeGovernorEvals(samples);
          const accessInventory = summarizeGovernorEvals(accessSamples);
          const baselineShortTaskSuccessRate = shortRuns.filter(Boolean).length / shortRuns.length;
          expect(summary).toMatchObject({
            samples: 20,
            restartResumeRate: 1,
            duplicateMutations: 0,
            duplicateReplies: 0,
          });
          expect(accessInventory).toMatchObject({ meaningfulCallsP95: 3, usefulActionRatio: 1 });
          expect(crashCheckpoints).toEqual(
            new Set([
              "after_ingress",
              "after_plan_and_start",
              "after_action_reservation",
              "after_mutation_provider_accept",
              "after_mutation_outcome",
              "after_delivery_provider_accept",
            ]),
          );
          expect(() =>
            assertGovernorMandatoryEvalGates({
              summary,
              accessInventory,
              baselineShortTaskSuccessRate,
            }),
          ).not.toThrow();
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("records a semantic failure as a rejected finish rather than a successful completion", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-semantic-eval-" },
      async (state) => {
        const capabilities = createMandatoryEvalRegistry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
        try {
          const taskId = controller.ingest({
            sourceMessageId: "semantic-failure",
            sourceSequence: 1,
            scope: mandatoryEvalScope(700),
            mode: "FOCUSED",
            contract: mandatoryEvalContract("Find a required synthetic record", false),
            now: 100,
          }).task.taskId;
          controller.preparePlan({ taskId, plan: mandatoryEvalPlan, now: 101 });
          controller.startExecution(taskId, 105);
          controller.recordToolOutcome({
            taskId,
            executionFence: controller.captureExecutionFence(taskId),
            proposal: {
              effectId: createGovernorEffectId("semantic-not-found"),
              criterionId: "verified",
              capability: "synthetic.inspect",
              capabilityVersion: "1",
              canonicalTarget: "fixture://missing",
              expectedEvidence: "Exact record",
              sourceRank: "structured_exact",
              stopCondition: "Record found",
              mutating: false,
              argumentsDigest: governorArgumentsDigest({ target: "missing" }),
            },
            progressVector: { searched: true },
            outcome: {
              transport: "completed",
              semantic: "not_found",
              sideEffect: "not_applicable",
              verification: "not_required",
              summaryCode: "not_found",
            },
            now: 106,
          });
          controller.beginVerification(taskId, 107);
          const finish = controller.proposeFinish({
            taskId,
            response: { framing: "summary", materialClaimIds: [] },
            now: 108,
          });
          expect(finish).toMatchObject({ completed: false });
          if (!finish.completed) {
            expect(finish.recovery.semanticFailures).toHaveLength(1);
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
