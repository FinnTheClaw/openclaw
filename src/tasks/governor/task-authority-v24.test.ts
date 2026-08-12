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
import { GovernorController } from "./controller.js";
import { createGovernorEventRecord } from "./events.js";
import { applyGovernorTransition } from "./state-machine.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorPlan, GovernorTaskContract, GovernorTaskScope } from "./types.js";

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

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "verify",
      description: "Verify the durable task",
      criterionIds: ["recovered"],
      dependsOn: [],
    },
  ],
};

function createStore(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  secrets: ReturnType<typeof resolveGovernorSecrets>;
  afterAppend?: () => void;
}) {
  const persistence = createGovernorHostPersistence({
    env: params.env,
    stateDir: params.stateDir,
    secrets: params.secrets,
    testMode: true,
    ...(params.afterAppend ? { testAfterLedgerAppend: params.afterAppend } : {}),
  });
  const broker = createHostGovernorBroker({ secrets: params.secrets, persistence });
  const store = new GovernorSqliteStore({
    stateDir: params.stateDir,
    receiptResolver: broker.resolver,
    approvalResolver: broker.approvalResolver,
    deliveryResolver: broker.deliveryResolver,
    physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
    memoryAuthority: broker.memoryAuthority,
    taskAuthority: broker.taskAuthority,
    secrets: params.secrets,
  });
  return { store, controller: new GovernorController(store, store.capabilities) };
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor V24 task authority crash protocol", () => {
  it("retries the same deterministic task after a host intent precedes primary rollback", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v24-task-intent-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const { store } = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 1) {
              throw new Error("synthetic task intent interruption");
            }
          },
        });
        expect(() => store.ingest(ingress)).toThrow(/synthetic task intent interruption/u);
        const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: state.stateDir } });
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 0,
        });
        const recovered = store.ingest({ ...ingress, now: 150 });
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
        const { store } = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 2) {
              throw new Error("synthetic task finalize interruption");
            }
          },
        });
        expect(() => store.ingest(ingress)).toThrow(/synthetic task finalize interruption/u);
        closeOpenClawStateDatabase();

        const restarted = createStore({ stateDir: state.stateDir, env, secrets }).store;
        const duplicate = restarted.ingest(ingress);
        expect(duplicate.kind).toBe("duplicate");
        expect(restarted.loadTask(duplicate.task.taskId)).toEqual(duplicate.task);
      },
    );
  });

  it("aborts an unapplied transition intent and retries from its authenticated predecessor", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-transition-retry-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const first = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 3) {
              throw new Error("synthetic transition intent interruption");
            }
          },
        });
        const created = first.store.ingest(ingress).task;
        expect(() =>
          first.controller.preparePlan({ taskId: created.taskId, plan, now: 200 }),
        ).toThrow(/synthetic transition intent interruption/u);
        closeOpenClawStateDatabase();

        const restarted = createStore({ stateDir: state.stateDir, env, secrets });
        const recovered = restarted.controller.preparePlan({
          taskId: created.taskId,
          plan,
          now: 300,
        });
        expect(recovered).toMatchObject({ state: "READY", planVersion: 1 });
        expect(restarted.store.loadTask(created.taskId)).toEqual(recovered);
      },
    );
  });

  it("does not let a concurrent read abort an in-flight task transition", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-transition-read-race-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const observer = createStore({ stateDir: state.stateDir, env, secrets }).store;
        const created = observer.ingest(ingress).task;
        let appendCount = 0;
        const writer = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 1) {
              expect(observer.loadTask(created.taskId)).toBeNull();
            }
          },
        });

        const transitioned = writer.controller.preparePlan({
          taskId: created.taskId,
          plan,
          now: 200,
        });
        expect(transitioned).toMatchObject({ state: "READY", planVersion: 1 });
        expect(observer.loadTask(created.taskId)).toEqual(transitioned);
      },
    );
  });

  it("recovers an interrupted correction and accepts an authenticated newer correction", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-correction-retry-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const first = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 3) {
              throw new Error("synthetic correction intent interruption");
            }
          },
        });
        first.store.ingest(ingress);
        const correction = {
          ...ingress,
          sourceMessageId: "task-authority-correction-v26",
          sourceSequence: 2,
          contract: { ...contract, objective: "Apply the authenticated correction" },
          now: 200,
        };
        expect(() => first.store.ingest(correction)).toThrow(
          /synthetic correction intent interruption/u,
        );
        closeOpenClawStateDatabase();

        const restarted = createStore({ stateDir: state.stateDir, env, secrets }).store;
        const exactRetry = restarted.ingest({ ...correction, now: 250 });
        expect(exactRetry).toMatchObject({
          kind: "corrected",
          task: { authenticatedSourceSequence: 2, objectiveRevision: 2 },
        });
        const newer = restarted.ingest({
          ...correction,
          sourceMessageId: "task-authority-newer-v26",
          sourceSequence: 3,
          contract: { ...contract, objective: "Apply the newer authenticated correction" },
          now: 300,
        });
        expect(newer).toMatchObject({
          kind: "corrected",
          task: {
            authenticatedSourceSequence: 3,
            objectiveRevision: 3,
            contract: { objective: "Apply the newer authenticated correction" },
          },
        });
        expect(restarted.loadTask(newer.task.taskId)).toEqual(newer.task);
      },
    );
  });

  it("accepts a newer correction after startup aborts an unapplied correction intent", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-correction-forward-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        let appendCount = 0;
        const first = createStore({
          stateDir: state.stateDir,
          env,
          secrets,
          afterAppend: () => {
            appendCount += 1;
            if (appendCount === 3) {
              throw new Error("synthetic correction intent interruption");
            }
          },
        }).store;
        first.ingest(ingress);
        expect(() =>
          first.ingest({
            ...ingress,
            sourceMessageId: "task-authority-skipped-correction-v26",
            sourceSequence: 2,
            contract: { ...contract, objective: "Interrupted correction" },
            now: 200,
          }),
        ).toThrow(/synthetic correction intent interruption/u);
        closeOpenClawStateDatabase();

        const restarted = createStore({ stateDir: state.stateDir, env, secrets }).store;
        const newer = restarted.ingest({
          ...ingress,
          sourceMessageId: "task-authority-forward-correction-v26",
          sourceSequence: 3,
          contract: { ...contract, objective: "Authenticated forward correction" },
          now: 300,
        });
        expect(newer).toMatchObject({
          kind: "corrected",
          task: {
            authenticatedSourceSequence: 3,
            objectiveRevision: 2,
            contract: { objective: "Authenticated forward correction" },
          },
        });
      },
    );
  });

  it("rolls back a failed SQLite transition and reconciles its authenticated intent", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-transition-rollback-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const { store } = createStore({ stateDir: state.stateDir, env, secrets });
        const current = store.ingest(ingress).task;
        const transition = applyGovernorTransition({
          task: current,
          expectedTaskVersion: current.taskVersion,
          expectedLeaseEpoch: current.leaseEpoch,
          to: "CONTRACTING",
          now: 200,
        });
        if (!transition.applied) {
          throw new Error("expected transition fixture");
        }
        const duplicateEventId = store.listEvents(current.taskId)[0]?.eventId;
        if (!duplicateEventId) {
          throw new Error("expected ingress event fixture");
        }
        const conflictingEvent = createGovernorEventRecord({
          task: transition.task,
          eventId: duplicateEventId,
          eventType: "state_transitioned",
          payload: { from: current.state, to: "CONTRACTING" },
          now: 200,
        });
        expect(() =>
          store.commit({ current, next: transition.task, event: conflictingEvent }),
        ).toThrow();
        expect(store.loadTask(current.taskId)).toEqual(current);

        const retry = applyGovernorTransition({
          task: current,
          expectedTaskVersion: current.taskVersion,
          expectedLeaseEpoch: current.leaseEpoch,
          to: "CONTRACTING",
          now: 210,
        });
        if (!retry.applied) {
          throw new Error("expected retry transition fixture");
        }
        const retryEvent = createGovernorEventRecord({
          task: retry.task,
          eventType: "state_transitioned",
          payload: { from: current.state, to: "CONTRACTING" },
          now: 210,
        });
        expect(store.commit({ current, next: retry.task, event: retryEvent })).toMatchObject({
          applied: true,
          task: { state: "CONTRACTING", taskVersion: 1 },
        });
      },
    );
  });
});
