import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGovernorTestHostBindings } from "../../security/governor-host-readonly.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorController } from "./controller.js";
import { MAX_GOVERNOR_PHYSICAL_EXECUTIONS } from "./fanout.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorPlan, GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-physical-cap",
  channel: "synthetic",
  accountId: "account-physical-cap",
  conversationId: "conversation-physical-cap",
  sessionId: "session-physical-cap",
  agentId: "agent-physical-cap",
  workspaceId: "workspace-physical-cap",
};
const contract: GovernorTaskContract = {
  objective: "Bound synthetic physical work",
  constraints: [],
  knownFacts: [],
  unknowns: ["worker results"],
  completionCriteria: [{ criterionId: "joined", description: "Workers joined", mandatory: true }],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};
const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    { stepId: "fanout", description: "Run workers", criterionIds: ["joined"], dependsOn: [] },
  ],
};

function storeWithHost(stateDir: string, host: ReturnType<typeof createGovernorTestHostBindings>) {
  return new GovernorSqliteStore({
    stateDir,
    receiptResolver: host.resolver,
    approvalResolver: host.approvalResolver,
    deliveryResolver: host.deliveryResolver,
    physicalExecutionCoordinator: host.physicalExecutionCoordinator,
    secrets: host.secrets,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor host-owned physical fanout cap", () => {
  it("keeps expired and restored workers in three slots until authenticated termination", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-physical-cap-" },
      async (state) => {
        const host = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const store = storeWithHost(state.stateDir, host);
        const controller = new GovernorController(store, store.capabilities);
        const ingress = controller.ingest({
          sourceMessageId: "physical-message",
          sourceSequence: 1,
          scope,
          mode: "DEEP",
          contract,
          now: 100,
        });
        controller.preparePlan({ taskId: ingress.task.taskId, plan, now: 110 });
        const task = controller.startExecution(ingress.task.taskId, 120);
        for (let index = 1; index <= 4; index += 1) {
          store.fanout.enqueue({
            jobId: `physical-${index}`,
            task,
            round: 1,
            priority: 0,
            fanoutGroup: "physical",
            payload: { index },
            now: 130 + index,
          });
        }
        const primaryPath = path.join(state.stateDir, "state", "openclaw.sqlite");
        const snapshotPath = path.join(state.root, "primary-before-claims.sqlite");
        closeOpenClawStateDatabase();
        fs.copyFileSync(primaryPath, snapshotPath);

        const claimed = Array.from({ length: 3 }, (_, index) =>
          store.fanout.claimNext({
            workerId: `long-worker-${index}`,
            now: 200 + index,
            leaseDurationMs: 10,
          }),
        );
        expect(claimed.every((result) => result.kind === "claimed")).toBe(true);
        expect(store.fanout.claimNext({ workerId: "worker-four", now: 213 })).toEqual({
          kind: "saturated",
        });
        const pending = store.fanout.listJobs(task.taskId).filter((job) => job.state === "running");
        expect(pending).toHaveLength(MAX_GOVERNOR_PHYSICAL_EXECUTIONS);
        expect(pending.every((job) => job.cancellationRequestedAt !== undefined)).toBe(true);
        const firstClaim = claimed[0];
        if (!firstClaim || firstClaim.kind !== "claimed") {
          throw new Error("expected first physical claim");
        }
        expect(
          store.fanout.complete({
            jobId: firstClaim.job.jobId,
            taskVersion: firstClaim.job.taskVersion,
            leaseEpoch: firstClaim.job.leaseEpoch,
            executionGeneration: firstClaim.job.executionGeneration,
            claimEpoch: firstClaim.job.claimEpoch,
            workerId: firstClaim.job.workerId ?? "",
            claims: [],
            evidence: [],
            unresolved: [],
            now: 214,
          }).kind,
        ).toBe("stale_worker");

        closeOpenClawStateDatabase();
        fs.copyFileSync(snapshotPath, primaryPath);
        const restartedHost = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const restarted = storeWithHost(state.stateDir, restartedHost);
        expect(restarted.fanout.claimNext({ workerId: "restored-worker", now: 220 })).toEqual({
          kind: "saturated",
        });
        for (let slot = 0; slot < MAX_GOVERNOR_PHYSICAL_EXECUTIONS; slot += 1) {
          const physical = restartedHost.physicalExecutionCoordinator.state(slot);
          if (!physical || physical.status !== "cancel_pending") {
            throw new Error(`expected pending physical slot ${slot}`);
          }
          const payload = {
            kind: "governor_orphaned_physical_execution_termination",
            taskId: task.taskId,
            physicalSlot: slot,
            physicalGeneration: physical.generation,
            physicalBindingDigest: physical.bindingDigest,
            outcome: "crashed" as const,
          };
          const receiptId = restartedHost.capabilities.submitObservedReceipt({
            scopeKey: task.scopeKey,
            taskId: task.taskId,
            taskVersion: task.taskVersion,
            objectiveRevision: task.objectiveRevision,
            planVersion: task.planVersion,
            sourceKind: "structured_external",
            sourceIdentity: "synthetic-process-supervisor",
            payload,
            observedAt: 221 + slot,
          });
          expect(
            restarted.fanout.acknowledgeOrphanedTermination({
              taskId: task.taskId,
              scopeKey: task.scopeKey,
              taskVersion: task.taskVersion,
              objectiveRevision: task.objectiveRevision,
              planVersion: task.planVersion,
              receiptId,
              slot,
              generation: physical.generation,
              bindingDigest: physical.bindingDigest,
              outcome: "crashed",
              now: 221 + slot,
            }),
          ).toBe(true);
        }
        const replayClaims = Array.from({ length: 3 }, (_, index) =>
          restarted.fanout.claimNext({ workerId: `recovered-${index}`, now: 230 + index }),
        );
        expect(replayClaims.every((result) => result.kind === "claimed")).toBe(true);
        expect(restarted.fanout.claimNext({ workerId: "still-fourth", now: 234 })).toEqual({
          kind: "saturated",
        });
      },
    );
  });

  it("releases a DB-completed slot after a crash before host-ledger release", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-physical-completion-recovery-" },
      async (state) => {
        const host = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const store = storeWithHost(state.stateDir, host);
        const controller = new GovernorController(store, store.capabilities);
        const ingress = controller.ingest({
          sourceMessageId: "physical-completion-message",
          sourceSequence: 1,
          scope,
          mode: "DEEP",
          contract,
          now: 300,
        });
        controller.preparePlan({ taskId: ingress.task.taskId, plan, now: 301 });
        const task = controller.startExecution(ingress.task.taskId, 302);
        for (let index = 1; index <= 4; index += 1) {
          store.fanout.enqueue({
            jobId: `completion-recovery-${index}`,
            task,
            round: 1,
            priority: 0,
            fanoutGroup: "completion-recovery",
            payload: { index },
            now: 302 + index,
          });
        }
        const claims = Array.from({ length: 3 }, (_, index) =>
          store.fanout.claimNext({
            workerId: `completion-worker-${index}`,
            now: 310 + index,
            leaseDurationMs: 100,
          }),
        );
        const completed = claims[0];
        if (!completed || completed.kind !== "claimed") {
          throw new Error("expected completion recovery claim");
        }
        const { db } = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        });
        db.prepare(
          `UPDATE governor_fanout_jobs
              SET state = 'completed', completed_at = ?, lease_expires_at = NULL, updated_at = ?
            WHERE job_id = ? AND state = 'running'`,
        ).run(320, 320, completed.job.jobId);

        const recovered = store.fanout.claimNext({
          workerId: "completion-recovery-fourth",
          now: 321,
          leaseDurationMs: 100,
        });
        expect(recovered.kind).toBe("claimed");
        const active = Array.from({ length: MAX_GOVERNOR_PHYSICAL_EXECUTIONS }, (_, slot) =>
          host.physicalExecutionCoordinator.state(slot),
        ).filter((entry) => entry?.status === "claimed" || entry?.status === "cancel_pending");
        expect(active).toHaveLength(MAX_GOVERNOR_PHYSICAL_EXECUTIONS);
      },
    );
  });
});
