import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostGovernorBroker } from "../../security/governor-host-broker.js";
import { createGovernorHostPersistence } from "../../security/governor-host-persistence.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "../../security/governor-host-secrets.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorEffectId } from "./types.js";

const scope = {
  principalId: "approval-recovery-principal",
  channel: "synthetic",
  accountId: "approval-recovery-account",
  conversationId: "approval-recovery-conversation",
  sessionId: "approval-recovery-session",
  agentId: "approval-recovery-agent",
  workspaceId: "approval-recovery-workspace",
};
const contract = {
  objective: "Cancel one revoked fixture mutation",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: ["approval-recovery.mutate"],
    canonicalTargets: ["fixture://approval-recovery"],
  },
};
const plan = {
  kind: "ordered" as const,
  steps: [{ stepId: "cancel", description: "Cancel", criterionIds: [], dependsOn: [] }],
};

function registry() {
  return new GovernorCapabilityRegistry([
    {
      capability: "approval-recovery.mutate",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: true,
    },
  ]);
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor approval revocation crash recovery", () => {
  it("reconciles a ledger-first crash and restored primary snapshot without a pending wedge", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-approval-recovery-" },
      async (state) => {
        let crashAfterLedgerAppend = false;
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const makeBroker = () =>
          createHostGovernorBroker({
            secrets,
            persistence: createGovernorHostPersistence({
              env,
              stateDir: state.stateDir,
              secrets,
              testMode: true,
              testAfterLedgerAppend: () => {
                if (crashAfterLedgerAppend) {
                  crashAfterLedgerAppend = false;
                  throw new Error("synthetic crash after approval ledger append");
                }
              },
            }),
          });
        const capabilities = registry();
        let broker = makeBroker();
        const makeStore = () =>
          new GovernorSqliteStore({
            stateDir: state.stateDir,
            receiptResolver: broker.resolver,
            approvalResolver: broker.approvalResolver,
            deliveryResolver: broker.deliveryResolver,
            physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
            secrets,
            capabilities,
          });
        let store = makeStore();
        let controller = new GovernorController(store, capabilities);
        const taskId = controller.ingest({
          sourceMessageId: "approval-recovery-message",
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
          throw new Error("expected approval recovery task");
        }
        const approvalReceipt = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "approval-recovery.mutate",
          capabilityVersion: "1",
          canonicalTarget: "fixture://approval-recovery",
          approverIdentity: "synthetic-host",
          approvalEpoch: 0,
          expiresAt: 500,
          observedAt: 103,
        });
        const grantId = store.admitAuthenticatedApproval({
          task,
          receiptId: approvalReceipt,
          now: 103,
        });
        const effectId = createGovernorEffectId("ledger-first-crash");
        const admitted = controller.admitAction({
          taskId,
          executionFence: controller.captureExecutionFence(taskId),
          proposal: {
            effectId,
            capability: "approval-recovery.mutate",
            capabilityVersion: "1",
            canonicalTarget: "fixture://approval-recovery",
            expectedEvidence: "No mutation occurred",
            sourceRank: "structured_exact",
            stopCondition: "Action is cancelled",
            mutating: true,
            argumentsDigest: governorArgumentsDigest({ operation: "fixture" }),
            approvalGrantId: grantId,
          },
          progressVector: { phase: "queued" },
          now: 104,
        });
        if (!admitted.accepted) {
          throw new Error("expected action admission");
        }
        const claim = controller.claimActionIntent({
          intent: admitted.intent,
          workerId: "approval-recovery-worker",
          leaseDurationMs: 100,
          now: 105,
        });
        if (claim.kind !== "claimed") {
          throw new Error("expected claimed action");
        }
        const primaryPath = path.join(state.stateDir, "state", "openclaw.sqlite");
        const preRevocation = path.join(state.root, "pre-revocation.sqlite");
        closeOpenClawStateDatabase();
        fs.copyFileSync(primaryPath, preRevocation);

        crashAfterLedgerAppend = true;
        expect(() =>
          broker.capabilities.submitApprovalRevocation({
            grantId,
            scopeKey: task.scopeKey,
            observedAt: 106,
          }),
        ).toThrow(/synthetic crash/u);

        closeOpenClawStateDatabase();
        broker = makeBroker();
        store = makeStore();
        controller = new GovernorController(store, capabilities);
        expect(store.actionIntents.listPendingIds(taskId, task.objectiveRevision, 107)).toEqual([]);
        expect(store.actionIntents.load(taskId, effectId)).toMatchObject({ state: "cancelled" });
        expect(
          controller.beginActionEffect({
            intent: claim.intent,
            workerId: "approval-recovery-worker",
            claimEpoch: claim.intent.claimEpoch,
            now: 107,
          }),
        ).toMatchObject({ kind: "stale_worker" });

        closeOpenClawStateDatabase();
        fs.copyFileSync(preRevocation, primaryPath);
        broker = makeBroker();
        store = makeStore();
        expect(store.actionIntents.listPendingIds(taskId, task.objectiveRevision, 108)).toEqual([]);
        expect(store.actionIntents.load(taskId, effectId)).toMatchObject({ state: "cancelled" });
        const replayReceipt = broker.capabilities.submitApprovalRevocation({
          grantId,
          scopeKey: task.scopeKey,
          observedAt: 109,
        });
        expect(
          store.applyAuthenticatedApprovalRevocation({ grantId, receiptId: replayReceipt }),
        ).toBe(true);

        controller = new GovernorController(store, capabilities);
        controller.beginVerification(taskId, 110);
        expect(
          controller.proposeFinish({
            taskId,
            response: { framing: "summary", materialClaimIds: [] },
            now: 111,
          }).completed,
        ).toBe(true);
      },
    );
  });
});
