import { afterEach, describe, expect, it } from "vitest";
import { createHostGovernorBroker } from "../../security/governor-host-broker.js";
import { createGovernorHostPersistence } from "../../security/governor-host-persistence.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "../../security/governor-host-secrets.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController } from "./controller.js";
import { GovernorRuntimeAdapter } from "./runtime-adapter.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore } from "./test-broker.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "v14-principal",
  channel: "synthetic",
  accountId: "v14-account",
  conversationId: "v14-conversation",
  sessionId: "v14-session",
  agentId: "v14-agent",
  workspaceId: "v14-workspace",
};
const contract: GovernorTaskContract = {
  objective: "Process an authenticated fixture",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

function complete(
  controller: GovernorController,
  taskId: ReturnType<GovernorController["ingest"]>["task"]["taskId"],
) {
  controller.preparePlan({ taskId, plan: { kind: "ordered", steps: [] }, now: 20 });
  controller.startExecution(taskId, 24);
  controller.beginVerification(taskId, 25);
  const result = controller.proposeFinish({
    taskId,
    response: { framing: "summary", materialClaimIds: [] },
    now: 26,
  });
  if (!result.completed) {
    throw new Error("expected terminal fixture task");
  }
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor V14 release blockers", () => {
  it("retains authenticated source order after terminal completion", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-terminal-order-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, new GovernorCapabilityRegistry([]));
        const newest = controller.ingest({
          sourceMessageId: "sequence-ten-message",
          sourceSequence: 10,
          scope,
          mode: "FOCUSED",
          contract,
          now: 10,
        });
        complete(controller, newest.task.taskId);
        const stale = controller.ingest({
          sourceMessageId: "sequence-nine-message",
          sourceSequence: 9,
          scope,
          mode: "FOCUSED",
          contract: { ...contract, objective: "Stale objective" },
          now: 30,
        });
        expect(stale.kind).toBe("stale");
        expect(stale.task.taskId).toBe(newest.task.taskId);
        const countAfterStale = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        })
          .db.prepare("SELECT COUNT(*) AS count FROM governor_tasks")
          .get();
        expect(countAfterStale).toEqual({ count: 1 });
        const later = controller.ingest({
          sourceMessageId: "sequence-eleven-message",
          sourceSequence: 11,
          scope,
          mode: "FOCUSED",
          contract: { ...contract, objective: "Newer objective" },
          now: 31,
        });
        expect(later.kind).toBe("created");
        expect(later.task.taskId).not.toBe(newest.task.taskId);
      },
    );
  });

  it("keeps independently authenticated source sequences separate", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-independent-order-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, new GovernorCapabilityRegistry([]));
        const first = controller.ingest({
          sourceMessageId: "source-alpha-message-ten",
          sourceSequence: 10,
          scope,
          mode: "FOCUSED",
          contract,
          now: 10,
        });
        complete(controller, first.task.taskId);
        const independent = controller.ingest({
          sourceMessageId: "source-beta-message-one",
          sourceSequence: 1,
          scope: { ...scope, sessionId: "v14-independent-session" },
          mode: "FOCUSED",
          contract: { ...contract, objective: "Independent authenticated source" },
          now: 30,
        });
        expect(independent.kind).toBe("created");
        expect(independent.task.taskId).not.toBe(first.task.taskId);
        const rows = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        })
          .db.prepare("SELECT COUNT(*) AS count FROM governor_ingress_source_highwater")
          .get();
        expect(rows).toEqual({ count: 2 });
      },
    );
  });

  it("keeps source ordering fail-closed after its terminal task is deleted", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-deleted-task-order-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, new GovernorCapabilityRegistry([]));
        const accepted = controller.ingest({
          sourceMessageId: "deleted-task-sequence-ten",
          sourceSequence: 10,
          scope,
          mode: "FOCUSED",
          contract,
          now: 10,
        });
        complete(controller, accepted.task.taskId);
        const db = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        }).db;
        db.prepare("DELETE FROM governor_tasks WHERE task_id = ?").run(accepted.task.taskId);
        expect(() =>
          controller.ingest({
            sourceMessageId: "deleted-task-sequence-nine",
            sourceSequence: 9,
            scope,
            mode: "FOCUSED",
            contract,
            now: 30,
          }),
        ).toThrow(/high-water references missing task/u);
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 0,
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM governor_ingress_source_highwater").get(),
        ).toEqual({ count: 1 });
      },
    );
  });

  it("recovers a crash after task ingestion without duplicating the task", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-ingest-crash-" },
      async (state) => {
        const first = createGovernorTestStore({ stateDir: state.stateDir });
        const firstController = new GovernorController(
          first.store,
          new GovernorCapabilityRegistry([]),
        );
        const receiptId = first.broker.capabilities.submitAuthenticatedOwnerIngress({
          channel: "signal",
          accountId: "crash-account-fixture",
          gatewayInstanceId: "crash-gateway-fixture",
          ownerPrincipal: "crash-owner-fixture",
          sourceMessageId: "crash-message-fixture",
          sourceSequence: 7,
          action: "repair",
          scopeKey: "crash-scope-fixture",
          nonce: "crash-nonce-fixture",
          observedAt: 100,
          expiresAt: 100_000,
        });
        const claim = first.broker.ownerIngressResolver.claim(receiptId, 101);
        if (!claim) {
          throw new Error("expected first owner-ingress claim");
        }
        const receipt = claim.receipt;
        const ingested = firstController.ingest({
          sourceMessageId: receipt.sourceMessageIdentity,
          sourceSequence: receipt.sourceSequence,
          scope: {
            principalId: receipt.ownerPrincipalIdentity,
            channel: receipt.channel,
            accountId: receipt.accountIdentity,
            conversationId: receipt.scopeKey,
            sessionId: receipt.sourceBindingIdentity,
            agentId: "governor-owner-ingress",
            workspaceId: receipt.deploymentIdentity,
          },
          mode: "FOCUSED",
          contract,
          now: 101,
        });
        closeOpenClawStateDatabase();

        const restarted = createGovernorTestStore({ stateDir: state.stateDir });
        const restartedController = new GovernorController(
          restarted.store,
          new GovernorCapabilityRegistry([]),
        );
        const adapter = new GovernorRuntimeAdapter(
          restartedController,
          restarted.broker.ownerIngressResolver,
        );
        const recovered = adapter.routeAuthenticatedOwnerIngress({
          receiptId,
          now: 30_102,
        });
        expect(recovered.kind).toBe("governed");
        if (recovered.kind !== "governed") {
          throw new Error("expected governed owner-ingress recovery");
        }
        expect(recovered.task.taskId).toBe(ingested.task.taskId);
        const db = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        }).db;
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 1,
        });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM governor_events WHERE event_type = 'task_received'",
            )
            .get(),
        ).toEqual({ count: 1 });
      },
    );
  });

  it("revokes a broker-issued approval before task-side admission", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-pre-admission-revoke-" },
      async (state) => {
        const { store, broker } = createGovernorTestStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, new GovernorCapabilityRegistry([]));
        const task = controller.ingest({
          sourceMessageId: "approval-task-message",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const receiptId = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "fixture.read",
          capabilityVersion: "1",
          canonicalTarget: "fixture://target",
          approverIdentity: "v14-approver-fixture",
          approvalEpoch: 0,
          expiresAt: 200,
          observedAt: 101,
        });
        const approval = broker.approvalResolver.resolveApproval(receiptId, task.scopeKey);
        if (!approval) {
          throw new Error("expected broker-issued approval");
        }
        expect(
          broker.capabilities.submitApprovalRevocation({
            grantId: approval.grantId,
            scopeKey: task.scopeKey,
            observedAt: 102,
          }),
        ).toBeTruthy();
        expect(broker.approvalResolver.resolveApproval(receiptId, task.scopeKey)).toBeNull();
        expect(() => store.admitAuthenticatedApproval({ task, receiptId, now: 103 })).toThrow(
          /invalid|stale/u,
        );
        const row = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        })
          .db.prepare("SELECT COUNT(*) AS count FROM governor_approval_grants")
          .get();
        expect(row).toEqual({ count: 0 });
      },
    );
  });

  it("rejects a held approval after ledger-first revocation crashes before SQLite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-approval-ledger-crash-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let crash = true;
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            if (crash) {
              crash = false;
              throw new Error("synthetic approval revocation crash");
            }
          },
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          secrets,
        });
        const controller = new GovernorController(store, new GovernorCapabilityRegistry([]));
        const task = controller.ingest({
          sourceMessageId: "approval-crash-task-message",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const receiptId = broker.capabilities.submitAuthenticatedApproval({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          objectiveRevision: task.objectiveRevision,
          capability: "fixture.read",
          capabilityVersion: "1",
          canonicalTarget: "fixture://target",
          approverIdentity: "approval-crash-approver",
          approvalEpoch: 0,
          expiresAt: 200,
          observedAt: 101,
        });
        const held = broker.approvalResolver.resolveApproval(receiptId, task.scopeKey);
        if (!held) {
          throw new Error("expected approval before revocation");
        }
        expect(() =>
          broker.capabilities.submitApprovalRevocation({
            grantId: held.grantId,
            scopeKey: task.scopeKey,
            observedAt: 102,
          }),
        ).toThrow(/synthetic approval revocation crash/u);
        expect(broker.approvalResolver.verifyApprovalReceiptCurrent(held)).toBe(false);
        expect(() => store.admitAuthenticatedApproval({ task, receiptId, now: 103 })).toThrow(
          /invalid|revoked/u,
        );
        const row = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        })
          .db.prepare("SELECT COUNT(*) AS count FROM governor_approval_grants")
          .get();
        expect(row).toEqual({ count: 0 });
      },
    );
  });
});
