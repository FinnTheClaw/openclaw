// Verifies host-owned adapter registration, certification, and durable replay fences.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController } from "./controller.js";
import type { GovernorDeliveryAdapter } from "./delivery-certification.js";
import { createGovernorTestStore } from "./test-broker.js";
import type { GovernorPlan, GovernorTaskScope } from "./types.js";

const plan: GovernorPlan = { kind: "ordered", steps: [] };
const scope: GovernorTaskScope = {
  principalId: "principal",
  channel: "synthetic",
  accountId: "account",
  conversationId: "conversation",
  sessionId: "session",
  agentId: "agent",
  workspaceId: "workspace",
};
const identity = { adapterId: "synthetic", version: "1", capability: "message.send" };
class Adapter implements GovernorDeliveryAdapter {
  readonly attempts: string[] = [];
  async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    return { deliveryKey: params.deliveryKey, receipt: { synthetic: true } };
  }
}
const controller = (store: import("./store.js").GovernorSqliteStore) =>
  new GovernorController(store, new GovernorCapabilityRegistry([]));
async function closeDatabaseForCleanup(): Promise<void> {
  closeOpenClawStateDatabase();
}
async function withDeliveryState(run: (state: OpenClawTestState) => Promise<void>): Promise<void> {
  await withOpenClawTestState({ layout: "state-only", prefix: "governor-delivery-" }, run);
}
function completion(governor: GovernorController) {
  const taskId = governor.ingest({
    sourceMessageId: "message",
    sourceSequence: 1,
    scope,
    mode: "FOCUSED",
    contract: {
      objective: "deliver",
      constraints: [],
      knownFacts: [],
      unknowns: [],
      completionCriteria: [],
      authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
    },
    now: 1,
  }).task.taskId;
  governor.preparePlan({ taskId, plan, now: 2 });
  governor.startExecution(taskId, 3);
  governor.beginVerification(taskId, 4);
  const result = governor.proposeFinish({
    taskId,
    response: { framing: "summary", materialClaimIds: [] },
    now: 5,
  });
  if (!result.completed) {
    throw new Error("expected completion");
  }
  const effectId = governor.store.outbox.list(taskId)[0]?.effectId;
  if (!effectId) throw new Error("expected completion outbox entry");
  return { taskId, effectId, expectedLeaseEpoch: result.task.leaseEpoch };
}
function register(
  broker: ReturnType<typeof createGovernorTestStore>["broker"],
  adapter: Adapter,
  generation: number,
) {
  return broker.capabilities.registerStaticDeliveryAdapter({
    identity,
    config: { fixture: "synthetic" },
    generation,
    factory: () => adapter,
  });
}
afterEach(() => closeOpenClawStateDatabase());

describe("governor delivery certification", () => {
  it("dispatches only a host-registered certified handle", async () => {
    await withDeliveryState(async (state) => {
      const { store, broker } = createGovernorTestStore({ stateDir: state.stateDir });
      const governed = controller(store);
      const entry = completion(governed);
      const adapter = new Adapter();
      await expect(
        governed.dispatchOutbox({ ...entry, workerId: "w", adapterHandle: "unregistered", now: 6 }),
      ).rejects.toThrow(/host-registered/);
      const handle = register(broker, adapter, 0);
      await governed.dispatchOutbox({ ...entry, workerId: "w", adapterHandle: handle, now: 8 });
      await governed.dispatchOutbox({ ...entry, workerId: "retry", adapterHandle: handle, now: 9 });
      expect(adapter.attempts).toHaveLength(1);
      await closeDatabaseForCleanup();
    });
  });

  it("rejects identity clones and old certified rows after host revocation", async () => {
    await withDeliveryState(async (state) => {
      const { store, broker } = createGovernorTestStore({ stateDir: state.stateDir });
      const governed = controller(store);
      const entry = completion(governed);
      const adapter = new Adapter();
      const handle = register(broker, adapter, 0);
      const clone: GovernorDeliveryAdapter = {
        async send(params) {
          return { deliveryKey: params.deliveryKey, receipt: {} };
        },
      };
      await expect(
        Promise.resolve().then(() =>
          broker.capabilities.registerStaticDeliveryAdapter({
            identity,
            config: { fixture: "synthetic" },
            generation: 0,
            factory: () => clone,
          }),
        ),
      ).rejects.toThrow(/already registered/);
      broker.capabilities.revokeDeliveryAdapter({ handle });
      await expect(
        governed.dispatchOutbox({ ...entry, workerId: "revoked", adapterHandle: handle, now: 11 }),
      ).rejects.toThrow(/revoked/);
      await closeDatabaseForCleanup();
    });
  });

  it("rejects forged durable certification rows", async () => {
    await withDeliveryState(async (state) => {
      const { store, broker } = createGovernorTestStore({ stateDir: state.stateDir });
      const governed = controller(store);
      const entry = completion(governed);
      const adapter = new Adapter();
      const handle = register(broker, adapter, 0);
      governed.store.resolveCertifiedDelivery(handle);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
      });
      db.prepare(
        "UPDATE governor_delivery_certifications SET certification_signature = 'forged' WHERE identity_key = ?",
      ).run(handle);
      await expect(
        governed.dispatchOutbox({ ...entry, workerId: "forged", adapterHandle: handle, now: 8 }),
      ).rejects.toThrow(/signature is invalid/);
      await closeDatabaseForCleanup();
    });
  });
});
