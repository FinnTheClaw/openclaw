// Heartbeat, cancellation, and authenticated physical-termination lifecycle for fanout jobs.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type {
  GovernorTrustedPhysicalExecutionCoordinator,
  GovernorTrustedReceiptResolver,
  HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { governorDigest } from "./canonical-json.js";
import { fanoutDb, parseJob, parseTaskProjection, type GovernorFanoutJob } from "./fanout-codec.js";
import {
  fanoutPhysicalBinding,
  fanoutPhysicalLease,
  fanoutTerminationReceiptPayload,
  reconcileFanoutPhysicalState,
  requestFanoutCancellation,
} from "./fanout-physical.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";

type LifecycleDependencies = Readonly<{
  options: OpenClawStateDatabaseOptions;
  physical: GovernorTrustedPhysicalExecutionCoordinator;
  receipts: GovernorTrustedReceiptResolver;
}>;

function loadJob(db: DatabaseSync, jobId: string): GovernorFanoutJob | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    fanoutDb(db).selectFrom("governor_fanout_jobs").selectAll().where("job_id", "=", jobId),
  );
  return row ? parseJob(row) : null;
}

export function cancelFanoutJob(
  dependencies: LifecycleDependencies,
  params: { jobId: string; disposition?: "cancel" | "requeue"; now: number },
): boolean {
  assertGovernorPersistedJson("log", params);
  return runOpenClawStateWriteTransaction(({ db }) => {
    reconcileFanoutPhysicalState({ db, coordinator: dependencies.physical, now: params.now });
    const job = loadJob(db, params.jobId);
    if (!job || job.state === "completed" || job.state === "cancelled") {
      return false;
    }
    if (job.state === "queued") {
      const update = executeSqliteQuerySync(
        db,
        fanoutDb(db)
          .updateTable("governor_fanout_jobs")
          .set({ state: "cancelled", cancelled_at: params.now, updated_at: params.now })
          .where("job_id", "=", job.jobId)
          .where("state", "=", "queued"),
      );
      return update.numAffectedRows === 1n;
    }
    if (job.cancellationRequestedAt !== undefined) {
      return false;
    }
    return requestFanoutCancellation({
      db,
      coordinator: dependencies.physical,
      job,
      disposition: params.disposition ?? "cancel",
      now: params.now,
    });
  }, dependencies.options);
}

export function heartbeatFanoutJob(
  dependencies: LifecycleDependencies,
  params: {
    jobId: string;
    claimEpoch: number;
    workerId: string;
    now: number;
    leaseDurationMs: number;
  },
): boolean {
  assertGovernorPersistedJson("log", params);
  return runOpenClawStateWriteTransaction(({ db }) => {
    reconcileFanoutPhysicalState({ db, coordinator: dependencies.physical, now: params.now });
    const job = loadJob(db, params.jobId);
    if (
      !job ||
      job.state !== "running" ||
      job.claimEpoch !== params.claimEpoch ||
      job.workerId !== params.workerId ||
      job.cancellationRequestedAt !== undefined
    ) {
      return false;
    }
    if (job.leaseExpiresAt === undefined || job.leaseExpiresAt <= params.now) {
      requestFanoutCancellation({
        db,
        coordinator: dependencies.physical,
        job,
        disposition: "requeue",
        now: params.now,
      });
      return false;
    }
    const lease = fanoutPhysicalLease(job);
    const state = dependencies.physical.state(lease.slot);
    if (
      state?.status !== "claimed" ||
      state.generation !== lease.generation ||
      state.bindingDigest !== lease.bindingDigest
    ) {
      return false;
    }
    const update = executeSqliteQuerySync(
      db,
      fanoutDb(db)
        .updateTable("governor_fanout_jobs")
        .set({ lease_expires_at: params.now + params.leaseDurationMs, updated_at: params.now })
        .where("job_id", "=", job.jobId)
        .where("state", "=", "running")
        .where("claim_epoch", "=", job.claimEpoch)
        .where("worker_id", "=", params.workerId),
    );
    return update.numAffectedRows === 1n;
  }, dependencies.options);
}

export function acknowledgeFanoutTermination(
  dependencies: LifecycleDependencies,
  params: {
    jobId: string;
    receiptId: HostGovernorReceiptId;
    outcome: "crashed" | "terminated";
    now: number;
  },
): boolean {
  assertGovernorPersistedJson("log", params);
  return runOpenClawStateWriteTransaction(({ db }) => {
    reconcileFanoutPhysicalState({ db, coordinator: dependencies.physical, now: params.now });
    let job = loadJob(db, params.jobId);
    if (!job) {
      return false;
    }
    const expectedPayload = fanoutTerminationReceiptPayload(job, params.outcome);
    const receipt = dependencies.receipts.resolve(
      params.receiptId,
      (() => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          fanoutDb(db)
            .selectFrom("governor_tasks")
            .select("projection_json")
            .where("task_id", "=", job.taskId),
        );
        return row ? parseTaskProjection(row.projection_json).scopeKey : "";
      })(),
    );
    const evidenceDigest = governorDigest({
      receiptId: params.receiptId,
      payload: expectedPayload,
    });
    if (
      job.terminationEvidenceDigest === evidenceDigest &&
      (job.state === "queued" || job.state === "cancelled")
    ) {
      return true;
    }
    if (
      !receipt ||
      job.state !== "running" ||
      job.cancellationRequestedAt === undefined ||
      receipt.taskId !== job.taskId ||
      receipt.taskVersion !== job.taskVersion ||
      receipt.objectiveRevision !== job.objectiveRevision ||
      receipt.planVersion !== job.planVersion ||
      receipt.sourceKind !== "structured_external" ||
      receipt.observedAt < job.cancellationRequestedAt ||
      receipt.observedAt > params.now ||
      governorDigest(receipt.payload) !== governorDigest(expectedPayload)
    ) {
      return false;
    }
    const binding = fanoutPhysicalBinding(job);
    const pending = dependencies.physical.requestCancellation(binding, fanoutPhysicalLease(job));
    if (!pending) {
      return false;
    }
    job = {
      ...job,
      physicalGeneration: pending.generation,
      physicalBindingDigest: pending.bindingDigest,
    };
    const terminal = dependencies.physical.acknowledgeTermination(binding, pending, params.outcome);
    if (!terminal) {
      return false;
    }
    const requeue = job.cancellationDisposition === "requeue";
    const update = executeSqliteQuerySync(
      db,
      fanoutDb(db)
        .updateTable("governor_fanout_jobs")
        .set({
          state: requeue ? "queued" : "cancelled",
          worker_id: null,
          lease_expires_at: null,
          physical_generation: terminal.generation,
          termination_outcome: params.outcome,
          termination_evidence_digest: evidenceDigest,
          termination_acknowledged_at: params.now,
          cancelled_at: requeue ? null : params.now,
          updated_at: params.now,
        })
        .where("job_id", "=", job.jobId)
        .where("state", "=", "running")
        .where("claim_epoch", "=", job.claimEpoch),
    );
    return update.numAffectedRows === 1n;
  }, dependencies.options);
}

export function acknowledgeOrphanedFanoutTermination(
  dependencies: LifecycleDependencies,
  params: {
    taskId: string;
    scopeKey: string;
    taskVersion: number;
    objectiveRevision: number;
    planVersion: number;
    receiptId: HostGovernorReceiptId;
    slot: number;
    generation: number;
    bindingDigest: string;
    outcome: "crashed" | "terminated";
    now: number;
  },
): boolean {
  assertGovernorPersistedJson("log", params);
  const receipt = dependencies.receipts.resolve(params.receiptId, params.scopeKey);
  const expectedPayload = {
    kind: "governor_orphaned_physical_execution_termination",
    taskId: params.taskId,
    physicalSlot: params.slot,
    physicalGeneration: params.generation,
    physicalBindingDigest: params.bindingDigest,
    outcome: params.outcome,
  } as const;
  if (
    !receipt ||
    receipt.taskId !== params.taskId ||
    receipt.taskVersion !== params.taskVersion ||
    receipt.objectiveRevision !== params.objectiveRevision ||
    receipt.planVersion !== params.planVersion ||
    receipt.sourceKind !== "structured_external" ||
    receipt.observedAt > params.now ||
    governorDigest(receipt.payload) !== governorDigest(expectedPayload)
  ) {
    return false;
  }
  return Boolean(
    dependencies.physical.acknowledgeOrphanedTermination(
      {
        slot: params.slot,
        generation: params.generation,
        bindingDigest: params.bindingDigest,
      },
      params.outcome,
    ),
  );
}
