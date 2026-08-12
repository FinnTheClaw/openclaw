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
import { fanoutDb, parseJob, replaceJob, type GovernorFanoutJob } from "./fanout-codec.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";

export function fanoutPhysicalBinding(job: GovernorFanoutJob): GovernorPhysicalExecutionBinding {
  if (!job.workerId) {
    throw new Error("GOVERNOR_FANOUT_PHYSICAL_WORKER_MISSING");
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
    throw new Error("GOVERNOR_FANOUT_PHYSICAL_LEASE_MISSING");
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
  assertGovernorPersistedJson("log", { job: params.job, now: params.now });
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
  return replaceJob(params.db, params.job, {
    ...params.job,
    physicalGeneration: pending.generation,
    physicalBindingDigest: pending.bindingDigest,
    cancellationDisposition: params.job.cancellationDisposition ?? "cancel",
    cancellationRequestedAt: params.job.cancellationRequestedAt ?? params.now,
    updatedAt: params.now,
  });
}

function reconcileReleasedJob(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  job: GovernorFanoutJob;
  now: number;
}): boolean {
  assertGovernorPersistedJson("log", { job: params.job, now: params.now });
  if (params.job.physicalSlot === undefined || !params.job.physicalBindingDigest) {
    return false;
  }
  const state = params.coordinator.state(params.job.physicalSlot);
  if (
    !state ||
    state.bindingDigest !== params.job.physicalBindingDigest ||
    (state.status !== "completed" && state.status !== "crashed" && state.status !== "terminated")
  ) {
    return false;
  }
  const requeue = state.status !== "completed" && params.job.cancellationDisposition === "requeue";
  const {
    cancelledAt: _cancelledAt,
    leaseExpiresAt: _leaseExpiresAt,
    workerId: _workerId,
    ...released
  } = params.job;
  return replaceJob(params.db, params.job, {
    ...released,
    state: requeue ? "queued" : "cancelled",
    physicalGeneration: state.generation,
    terminationOutcome: state.status,
    terminationEvidenceDigest: state.ledgerDigest,
    terminationAcknowledgedAt: params.now,
    ...(requeue ? {} : { cancelledAt: params.now }),
    updatedAt: params.now,
  });
}

/** Reconciles only host-proven terminal work and fences every expired lease. */
export function reconcileFanoutPhysicalState(params: {
  db: DatabaseSync;
  coordinator: GovernorTrustedPhysicalExecutionCoordinator;
  now: number;
}): { unprovableRunning: boolean } {
  assertGovernorPersistedJson("log", { now: params.now });
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
      const disposition =
        job.cancellationDisposition ??
        (job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= params.now
          ? ("requeue" as const)
          : ("cancel" as const));
      if (!requestFanoutCancellation({ ...params, job, disposition })) {
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
  assertGovernorPersistedJson("log", {
    job: params.job,
    disposition: params.disposition,
    now: params.now,
  });
  const requested: GovernorFanoutJob = {
    ...params.job,
    cancellationDisposition: params.disposition,
    cancellationRequestedAt: params.job.cancellationRequestedAt ?? params.now,
    updatedAt: params.now,
  };
  if (!replaceJob(params.db, params.job, requested)) {
    return false;
  }
  return applyCancellationFence({
    ...params,
    job: requested,
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
