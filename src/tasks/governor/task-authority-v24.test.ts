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
import { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-v24",
  channel: "synthetic",
  accountId: "account-v24",
  conversationId: "conversation-v24",
  sessionId: "session-v24",
  agentId: "agent-v24",
  workspaceId: "workspace-v24",
};

const contract: GovernorTaskContract = {
  objective: "Verify task fence crash recovery",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [
    { criterionId: "recovered", description: "The durable task is current", mandatory: true },
  ],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

const ingress = {
  sourceMessageId: "task-authority-message-v24",
  sourceSequence: 1,
  scope,
  mode: "FOCUSED" as const,
  contract,
  now: 100,
};

afterEach(() => closeOpenClawStateDatabase());

describe("governor V24 task authority crash protocol", () => {
  it("retries the same deterministic task after a host intent precedes primary rollback", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v24-task-intent-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            appendCount += 1;
            if (appendCount === 1) {
              throw new Error("synthetic task intent interruption");
            }
          },
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          memoryAuthority: broker.memoryAuthority,
          taskAuthority: broker.taskAuthority,
          secrets,
        });
        expect(() => store.ingest(ingress)).toThrow(/synthetic task intent interruption/u);
        const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: state.stateDir } });
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 0,
        });
        const recovered = store.ingest(ingress);
        expect(recovered.kind).toBe("created");
        expect(store.loadTask(recovered.task.taskId)).toEqual(recovered.task);
      },
    );
  });

  it("recovers a committed primary task after interruption during host finalization", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v24-task-finalize-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            appendCount += 1;
            if (appendCount === 2) {
              throw new Error("synthetic task finalize interruption");
            }
          },
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          memoryAuthority: broker.memoryAuthority,
          taskAuthority: broker.taskAuthority,
          secrets,
        });
        expect(() => store.ingest(ingress)).toThrow(/synthetic task finalize interruption/u);
        closeOpenClawStateDatabase();

        const restartedPersistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
        });
        const restartedBroker = createHostGovernorBroker({
          secrets,
          persistence: restartedPersistence,
        });
        const restarted = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: restartedBroker.resolver,
          approvalResolver: restartedBroker.approvalResolver,
          deliveryResolver: restartedBroker.deliveryResolver,
          physicalExecutionCoordinator: restartedBroker.physicalExecutionCoordinator,
          memoryAuthority: restartedBroker.memoryAuthority,
          taskAuthority: restartedBroker.taskAuthority,
          secrets,
        });
        const duplicate = restarted.ingest(ingress);
        expect(duplicate.kind).toBe("duplicate");
        expect(restarted.loadTask(duplicate.task.taskId)).toEqual(duplicate.task);
      },
    );
  });
});
