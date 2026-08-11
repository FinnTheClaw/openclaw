// Runs the mandatory synthetic replay, crash, idempotency, efficiency, and deep-work gates.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import {
  GovernorHostDeliveryCertificationAuthority,
  type GovernorDeliveryAdapter,
} from "./delivery-certification.js";
import {
  assertGovernorMandatoryEvalGates,
  summarizeGovernorEvals,
  type GovernorEvalSample,
} from "./eval-harness.js";
import { GovernorRuntimeAdapter } from "./runtime-adapter.js";
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

class ObservedMutationAdapter {
  readonly attempts: string[] = [];
  readonly observableEffects: string[] = [];

  apply(idempotencyKey: string): void {
    this.attempts.push(idempotencyKey);
    if (!this.observableEffects.includes(idempotencyKey)) {
      this.observableEffects.push(idempotencyKey);
    }
  }
}

class ObservedDeliveryAdapter implements GovernorDeliveryAdapter {
  readonly identity = { adapterId: "synthetic-eval", version: "1", capability: "message.send" };
  readonly attempts: string[] = [];
  readonly observableSends: string[] = [];

  async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    if (!this.observableSends.includes(params.deliveryKey)) {
      this.observableSends.push(params.deliveryKey);
    }
    return { deliveryKey: params.deliveryKey, receipt: { provider: "synthetic-eval" } };
  }
}

class BrokenMutationAdapter extends ObservedMutationAdapter {
  override apply(idempotencyKey: string): void {
    this.attempts.push(idempotencyKey);
    this.observableEffects.push(idempotencyKey);
  }
}

class BrokenDeliveryAdapter extends ObservedDeliveryAdapter {
  override async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    this.observableSends.push(params.deliveryKey);
    return { deliveryKey: params.deliveryKey, receipt: { provider: "broken-synthetic-eval" } };
  }
}

function countForKey(entries: readonly string[], key: string): number {
  return entries.filter((entry) => entry === key).length;
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

  it("observes duplicate, crash, access, and short-task gates from deterministic executions", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-crash-eval-" },
      async (state) => {
        let store = new GovernorSqliteStore({ stateDir: state.stateDir });
        let controller = new GovernorController(store, registry());
        const mutationAdapter = new ObservedMutationAdapter();
        const deliveryAdapter = new ObservedDeliveryAdapter();
        store.deliveryCertifications.hostCertify({
          authority: GovernorHostDeliveryCertificationAuthority.fromEnvironment(),
          identity: deliveryAdapter.identity,
          now: 1,
        });
        const samples: GovernorEvalSample[] = [];
        const accessSamples: GovernorEvalSample[] = [];
        const crashCheckpoints = new Set<string>();
        const reopen = (checkpoint: string) => {
          crashCheckpoints.add(checkpoint);
          closeOpenClawStateDatabase();
          store = new GovernorSqliteStore({ stateDir: state.stateDir });
          controller = new GovernorController(store, registry());
        };

        try {
          for (let index = 0; index < 20; index += 1) {
            const base = index * 1_000;
            const sourceMessageId = `crash-message-${index}`;
            const first = controller.ingest({
              sourceMessageId,
              sourceSequence: 1,
              scope: scope(100 + index),
              mode: "FOCUSED",
              contract: contract(`Crash recovery ${index}`, true),
              now: base + 100,
            });
            const duplicateIds = await Promise.all(
              Array.from(
                { length: 20 },
                async () =>
                  controller.ingest({
                    sourceMessageId,
                    sourceSequence: 1,
                    scope: scope(100 + index),
                    mode: "FOCUSED",
                    contract: contract(`Crash recovery ${index}`, true),
                    now: base + 101,
                  }).task.taskId,
              ),
            );
            expect(new Set([first.task.taskId, ...duplicateIds]).size).toBe(1);
            const taskId = first.task.taskId;
            reopen("after_ingress");

            controller.preparePlan({ taskId, plan, now: base + 110 });
            controller.startExecution(taskId, base + 120);
            reopen("after_plan_and_start");

            const accessCalls: Array<{ accepted: boolean; semantic?: string }> = [];
            for (let operation = 0; operation < 3; operation += 1) {
              const outcome = controller.recordToolOutcome({
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
                  evidence: { index, operation, found: true },
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
                proposal: mutationProposal(effectId),
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
            mutationAdapter.apply(oldClaim.intent.idempotencyKey);
            reopen("after_mutation_provider_accept");

            const newClaim = controller.claimActionIntent({
              intent: reservation.intent,
              workerId: `new-action-${index}`,
              leaseDurationMs: 10,
              now: base + 141,
            });
            if (newClaim.kind !== "claimed") {
              throw new Error("missing reclaimed action");
            }
            mutationAdapter.apply(newClaim.intent.idempotencyKey);
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
                now: base + 142,
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
              now: base + 143,
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
            const oldDelivery = store.outbox.claim({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `old-delivery-${index}`,
              leaseDurationMs: 10,
              now: base + 160,
            });
            if (oldDelivery.kind !== "claimed") {
              throw new Error("missing old delivery claim");
            }
            await deliveryAdapter.send({
              deliveryKey: oldDelivery.entry.deliveryKey,
              payload: oldDelivery.entry.payload,
            });
            reopen("after_delivery_provider_accept");
            await controller.dispatchOutbox({
              taskId,
              effectId: outbox.effectId,
              expectedLeaseEpoch: completion.task.leaseEpoch,
              workerId: `new-delivery-${index}`,
              leaseDurationMs: 10,
              adapter: deliveryAdapter,
              now: base + 171,
            });
            const mutationAttempts = mutationAdapter.attempts.filter(
              (key) => key === newClaim.intent.idempotencyKey,
            );
            const deliveryAttempts = deliveryAdapter.attempts.filter(
              (key) => key === oldDelivery.entry.deliveryKey,
            );
            samples.push({
              success:
                store.listEffects(taskId).length === 4 &&
                store.outbox.list(taskId)[0]?.state === "sent",
              prematureCompletion: false,
              resumedAfterCrash: true,
              duplicateMutation:
                countForKey(mutationAdapter.observableEffects, newClaim.intent.idempotencyKey) > 1,
              duplicateReply:
                countForKey(deliveryAdapter.observableSends, oldDelivery.entry.deliveryKey) > 1,
              meaningfulCalls: mutationAttempts.length + deliveryAttempts.length,
              usefulCalls: 2,
            });
            expect(mutationAttempts).toHaveLength(2);
            expect(deliveryAttempts).toHaveLength(2);
            expect(
              countForKey(mutationAdapter.observableEffects, newClaim.intent.idempotencyKey),
            ).toBe(1);
            expect(
              countForKey(deliveryAdapter.observableSends, oldDelivery.entry.deliveryKey),
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
              scope: scope(500 + index),
              profile: quickProfile,
              contract: contract("Prompt-contained quick chat", false),
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

  it("fails the mandatory gate when a broken adapter produces duplicate observable effects", () => {
    const mutation = new BrokenMutationAdapter();
    const delivery = new BrokenDeliveryAdapter();
    mutation.apply("stable-mutation-key");
    mutation.apply("stable-mutation-key");
    void delivery.send({ deliveryKey: "stable-delivery-key", payload: {} });
    void delivery.send({ deliveryKey: "stable-delivery-key", payload: {} });
    const summary = summarizeGovernorEvals([
      {
        success: true,
        prematureCompletion: false,
        resumedAfterCrash: true,
        duplicateMutation: countForKey(mutation.observableEffects, "stable-mutation-key") > 1,
        duplicateReply: countForKey(delivery.observableSends, "stable-delivery-key") > 1,
        meaningfulCalls: mutation.attempts.length + delivery.attempts.length,
        usefulCalls: 2,
      },
    ]);
    expect(() =>
      assertGovernorMandatoryEvalGates({
        summary,
        accessInventory: summarizeGovernorEvals([
          {
            success: true,
            prematureCompletion: false,
            resumedAfterCrash: true,
            duplicateMutation: false,
            duplicateReply: false,
            meaningfulCalls: 1,
            usefulCalls: 1,
          },
        ]),
        baselineShortTaskSuccessRate: 1,
      }),
    ).toThrow(/duplicate_mutation.*duplicate_reply/u);
  });

  it("records a semantic failure as a rejected finish rather than a successful completion", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-semantic-eval-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, registry());
        try {
          const taskId = controller.ingest({
            sourceMessageId: "semantic-failure",
            sourceSequence: 1,
            scope: scope(700),
            mode: "FOCUSED",
            contract: contract("Find a required synthetic record", false),
            now: 100,
          }).task.taskId;
          controller.preparePlan({ taskId, plan, now: 101 });
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
