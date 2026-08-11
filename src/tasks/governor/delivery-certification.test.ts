// Exercises the host-owned delivery certification boundary and crash-safe adapter contract.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController } from "./controller.js";
import {
  GovernorDeliveryCertificationRegistry,
  type GovernorDeliveryAdapter,
} from "./delivery-certification.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorPlan, GovernorTaskScope } from "./types.js";

const emptyPlan: GovernorPlan = { kind: "ordered", steps: [] };

function scope(index: number): GovernorTaskScope {
  return {
    principalId: `principal-delivery-${index}`,
    channel: "synthetic",
    accountId: `account-delivery-${index}`,
    conversationId: `conversation-delivery-${index}`,
    sessionId: `session-delivery-${index}`,
    agentId: "agent-delivery",
    workspaceId: "workspace-delivery",
  };
}

function controller(store: GovernorSqliteStore): GovernorController {
  return new GovernorController(store, new GovernorCapabilityRegistry([]));
}

function completion(controller: GovernorController, index: number) {
  const taskId = controller.ingest({
    sourceMessageId: `delivery-message-${index}`,
    sourceSequence: 1,
    scope: scope(index),
    mode: "FOCUSED",
    contract: {
      objective: "Deliver a non-material synthetic acknowledgement",
      constraints: [],
      knownFacts: [],
      unknowns: [],
      completionCriteria: [],
      authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
    },
    now: index * 100,
  }).task.taskId;
  controller.preparePlan({ taskId, plan: emptyPlan, now: index * 100 + 1 });
  controller.startExecution(taskId, index * 100 + 5);
  controller.beginVerification(taskId, index * 100 + 6);
  const finished = controller.proposeFinish({
    taskId,
    response: { framing: "summary", materialClaimIds: [] },
    now: index * 100 + 7,
  });
  if (!finished.completed) {
    throw new Error("expected completion outbox");
  }
  return {
    taskId,
    expectedLeaseEpoch: finished.task.leaseEpoch,
    effectId: `completion_${finished.task.objectiveRevision}`,
  };
}

class RecordingDeliveryAdapter implements GovernorDeliveryAdapter {
  readonly identity = { adapterId: "synthetic-delivery", version: "1", capability: "message.send" };
  readonly attempts: string[] = [];
  readonly accepted = new Set<string>();
  rejectNext = false;

  async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("synthetic provider rejection");
    }
    this.accepted.add(params.deliveryKey);
    return { deliveryKey: params.deliveryKey, receipt: { provider: "synthetic" } };
  }
}

function certifications(adapter: RecordingDeliveryAdapter, status: "certified" | "revoked") {
  return new GovernorDeliveryCertificationRegistry([{ ...adapter.identity, status }]);
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor delivery adapter certification", () => {
  it("fails closed for uncertified and revoked adapters", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-delivery-cert-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const governed = controller(store);
        const entry = completion(governed, 1);
        const adapter = new RecordingDeliveryAdapter();
        try {
          await expect(
            governed.dispatchOutbox({
              ...entry,
              workerId: "uncertified",
              adapter,
              certifications: new GovernorDeliveryCertificationRegistry([]),
              now: 110,
            }),
          ).rejects.toThrow(/uncertified/);
          await expect(
            governed.dispatchOutbox({
              ...entry,
              workerId: "revoked",
              adapter,
              certifications: certifications(adapter, "revoked"),
              now: 111,
            }),
          ).rejects.toThrow(/revoked/);
          expect(adapter.attempts).toEqual([]);
          expect(store.outbox.list(entry.taskId)[0]).toMatchObject({ state: "pending" });
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("preserves a stable delivery key through accepted-send crash recovery and provider rejection", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-delivery-crash-" },
      async (state) => {
        let store = new GovernorSqliteStore({ stateDir: state.stateDir });
        let governed = controller(store);
        const adapter = new RecordingDeliveryAdapter();
        const registry = certifications(adapter, "certified");
        try {
          const first = completion(governed, 1);
          const claimed = store.outbox.claim({
            ...first,
            workerId: "crashed-after-accept",
            leaseDurationMs: 5,
            now: 110,
          });
          if (claimed.kind !== "claimed") {
            throw new Error("expected first delivery claim");
          }
          await adapter.send({
            deliveryKey: claimed.entry.deliveryKey,
            payload: claimed.entry.payload,
          });
          closeOpenClawStateDatabase();
          store = new GovernorSqliteStore({ stateDir: state.stateDir });
          governed = controller(store);
          await governed.dispatchOutbox({
            ...first,
            workerId: "recovered-after-accept",
            adapter,
            certifications: registry,
            now: 116,
          });
          const replay = await governed.dispatchOutbox({
            ...first,
            workerId: "duplicate-retry",
            adapter,
            certifications: registry,
            now: 117,
          });
          expect(replay.kind).toBe("already_sent");
          expect(adapter.attempts).toHaveLength(2);
          expect(adapter.accepted).toHaveLength(1);

          const rejected = completion(governed, 2);
          adapter.rejectNext = true;
          await expect(
            governed.dispatchOutbox({
              ...rejected,
              workerId: "provider-reject",
              adapter,
              certifications: registry,
              now: 210,
            }),
          ).rejects.toThrow(/provider rejection/);
          expect(store.outbox.list(rejected.taskId)[0]).toMatchObject({ state: "claimed" });
          await governed.dispatchOutbox({
            ...rejected,
            workerId: "provider-retry",
            adapter,
            certifications: registry,
            now: 60_211,
          });
          expect(adapter.accepted).toHaveLength(2);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
