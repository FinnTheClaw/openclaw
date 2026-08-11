// Coordinates durable fanout rows with the host-owned three-slot physical ledger.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  GovernorPhysicalExecutionBinding,
  GovernorPhysicalExecutionLease,
  GovernorTrustedPhysicalExecutionCoordinator,
} from "../../security/governor-host-readonly.js";
import { governorDigest } from "./canonical-json.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { fanoutDb, parseJob, type GovernorFanoutJob } from "./fanout-codec.js";

export function fanoutPhysicalBinding(job: GovernorFanoutJob): GovernorPhysicalExecutionBinding {
  if (!job.workerId) {
    throw new Error(`Governor fanout job ${job.jobId} has no physical worker`);
  }
  return {
    jobId: job.jobId,
    taskId: job.taskId,
    taskVersion: job.taskVersion,
    objectiveRevision: job.objectiveRevision,
    planVersion: job.planVersion,
    leaseEpoch: job.leaseEpoch,
    executionGeneration: job.executionGeneration,
    claimEpoch: job.claimEpoch,
    workerIdentity: governorDigest({ workerId: job.workerId }),
  };
}

export function fanoutPhysicalLease(job: GovernorFanoutJob): GovernorPhysicalExecutionLease {
  if (
    job.physicalSlot === undefined ||
    job.physicalGeneration === undefined ||
    !job.physicalBindingDigest
  ) {
    throw new Error(`Governor fanout job ${job.jobId} has no durable physical lease`);
  }
  return {
    slot: job.physicalSlot,
    generation: job.physicalGeneration,
    bindingDigest: job.physicalBindingDigest,
  };
}

function applyCancellationFence(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  job: GovernorFanoutJob;
  now: number;
}): boolean {
  let lease: GovernorPhysicalExecutionLease;
  try {
    lease = fanoutPhysicalLease(params.job);
  } catch {
    // A legacy/restored running row without a host slot is unprovable. Keep it
    // running and block new physical admission until explicit operator repair.
    return false;
  }
  const pending = params.coordinator.requestCancellation(fanoutPhysicalBinding(params.job), lease);
  if (!pending) {
    return false;
  }
  executeSqliteQuerySync(
    params.db,
    fanoutDb(params.db)
      .updateTable("governor_fanout_jobs")
      .set({
        physical_generation: pending.generation,
        physical_binding_digest: pending.bindingDigest,
        cancellation_disposition: params.job.cancellationDisposition ?? "cancel",
        cancellation_requested_at: params.job.cancellationRequestedAt ?? params.now,
        updated_at: params.now,
      })
      .where("job_id", "=", params.job.jobId)
      .where("state", "=", "running")
      .where("claim_epoch", "=", params.job.claimEpoch),
  );
  return true;
}

function reconcileReleasedJob(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  job: GovernorFanoutJob;
  now: number;
}): boolean {
  if (params.job.physicalSlot === undefined || !params.job.physicalBindingDigest) {
    return false;
  }
  const state = params.coordinator.state(params.job.physicalSlot);
  if (
    !state ||
    state.bindingDigest !== params.job.physicalBindingDigest ||
    !["completed", "crashed", "terminated"].includes(state.status)
  ) {
    return false;
  }
  const requeue = state.status !== "completed" && params.job.cancellationDisposition === "requeue";
  executeSqliteQuerySync(
    params.db,
    fanoutDb(params.db)
      .updateTable("governor_fanout_jobs")
      .set({
        state: requeue ? "queued" : "cancelled",
        worker_id: null,
        lease_expires_at: null,
        physical_generation: state.generation,
        termination_outcome: state.status,
        termination_evidence_digest: state.ledgerDigest,
        termination_acknowledged_at: params.now,
        cancelled_at: requeue ? null : params.now,
        updated_at: params.now,
      })
      .where("job_id", "=", params.job.jobId)
      .where("state", "=", "running")
      .where("claim_epoch", "=", params.job.claimEpoch),
  );
  return true;
}

/** Reconciles only host-proven terminal work and fences every expired lease. */
export function reconcileFanoutPhysicalState(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  now: number;
}): { unprovableRunning: boolean } {
  const rows = executeSqliteQuerySync(
    params.db,
    fanoutDb(params.db)
      .selectFrom("governor_fanout_jobs")
      .selectAll()
      .where("state", "in", ["running", "completed"]),
  ).rows;
  let unprovableRunning = false;
  for (const row of rows) {
    let job = parseJob(row);
    if (job.state === "completed") {
      try {
        const lease = fanoutPhysicalLease(job);
        const state = params.coordinator.state(lease.slot);
        if (
          state?.status === "claimed" &&
          state.generation === lease.generation &&
          state.bindingDigest === lease.bindingDigest
        ) {
          params.coordinator.complete(fanoutPhysicalBinding(job), lease);
        }
      } catch {
        // A completed row does not authorize new work. Missing legacy physical
        // metadata is retained for audit but cannot inflate live concurrency.
      }
      continue;
    }
    if (reconcileReleasedJob({ ...params, job })) {
      continue;
    }
    const cancellationDue =
      job.cancellationRequestedAt !== undefined ||
      (job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= params.now);
    if (cancellationDue) {
      const requestedJob = {
        ...job,
        cancellationDisposition:
          job.cancellationDisposition ??
          (job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= params.now
            ? ("requeue" as const)
            : ("cancel" as const)),
      };
      if (!applyCancellationFence({ ...params, job: requestedJob })) {
        unprovableRunning = true;
        continue;
      }
      const refreshed = executeSqliteQuerySync(
        params.db,
        fanoutDb(params.db)
          .selectFrom("governor_fanout_jobs")
          .selectAll()
          .where("job_id", "=", job.jobId),
      ).rows[0];
      if (refreshed) {
        job = parseJob(refreshed);
        reconcileReleasedJob({ ...params, job });
      }
    } else if (
      job.physicalSlot === undefined ||
      !params.coordinator.state(job.physicalSlot) ||
      params.coordinator.state(job.physicalSlot)?.bindingDigest !== job.physicalBindingDigest
    ) {
      unprovableRunning = true;
    }
  }
  return { unprovableRunning };
}

export function requestFanoutCancellation(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  job: GovernorFanoutJob;
  disposition: "cancel" | "requeue";
  now: number;
}): boolean {
  executeSqliteQuerySync(
    params.db,
    fanoutDb(params.db)
      .updateTable("governor_fanout_jobs")
      .set({
        cancellation_disposition: params.disposition,
        cancellation_requested_at: params.job.cancellationRequestedAt ?? params.now,
        updated_at: params.now,
      })
      .where("job_id", "=", params.job.jobId)
      .where("state", "=", "running")
      .where("claim_epoch", "=", params.job.claimEpoch),
  );
  return applyCancellationFence({
    ...params,
    job: { ...params.job, cancellationDisposition: params.disposition },
  });
}

export function fanoutTerminationReceiptPayload(
  job: GovernorFanoutJob,
  outcome: "crashed" | "terminated",
): GovernorJsonValue {
  const lease = fanoutPhysicalLease(job);
  return {
    kind: "governor_physical_execution_termination",
    jobId: job.jobId,
    claimEpoch: job.claimEpoch,
    physicalSlot: lease.slot,
    physicalGeneration: lease.generation,
    physicalBindingDigest: lease.bindingDigest,
    disposition: job.cancellationDisposition ?? "cancel",
    outcome,
  };
}
