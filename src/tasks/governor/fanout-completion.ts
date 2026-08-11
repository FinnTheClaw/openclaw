// Persists structured fanout results before releasing the host-owned physical slot.
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
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  bindEnvelope,
  fanoutDb,
  parseEnvelope,
  parseJob,
  parseTaskProjection,
  type GovernorFaninEnvelope,
  type GovernorFanoutCompletion,
} from "./fanout-codec.js";
import {
  fanoutPhysicalBinding,
  fanoutPhysicalLease,
  requestFanoutCancellation,
} from "./fanout-physical.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";

export type CompleteFanoutParams = {
  jobId: string;
  taskVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  claimEpoch: number;
  workerId: string;
  claims: readonly GovernorJsonValue[];
  evidence: readonly GovernorJsonValue[];
  unresolved: readonly GovernorJsonValue[];
  now: number;
  terminalReceiptId?: HostGovernorReceiptId;
};

function isExternalChild(payload: GovernorJsonValue): boolean {
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, GovernorJsonValue>).kind === "governor_external_child"
  );
}

export function completeFanoutJob(
  dependencies: {
    options: OpenClawStateDatabaseOptions;
    physical: GovernorTrustedPhysicalExecutionCoordinator;
    receipts: GovernorTrustedReceiptResolver;
  },
  params: CompleteFanoutParams,
): GovernorFanoutCompletion {
  assertGovernorPersistedJson("log", params);
  const content = assertGovernorBoundarySafe("session", {
    claims: [...params.claims],
    evidence: [...params.evidence],
    unresolved: [...params.unresolved],
  }) as {
    claims: GovernorJsonValue[];
    evidence: GovernorJsonValue[];
    unresolved: GovernorJsonValue[];
  };
  let release:
    | {
        binding: ReturnType<typeof fanoutPhysicalBinding>;
        lease: ReturnType<typeof fanoutPhysicalLease>;
      }
    | undefined;
  const result = runOpenClawStateWriteTransaction(({ db }) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      fanoutDb(db)
        .selectFrom("governor_fanout_jobs")
        .selectAll()
        .where("job_id", "=", params.jobId),
    );
    if (!row) {
      return { kind: "not_found" } as const;
    }
    const job = parseJob(row);
    const envelopeDigest = governorDigest({
      jobId: job.jobId,
      taskId: job.taskId,
      planVersion: job.planVersion,
      round: job.round,
      ...content,
    });
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      fanoutDb(db)
        .selectFrom("governor_fanin_envelopes")
        .selectAll()
        .where("job_id", "=", job.jobId),
    );
    if (existing) {
      const envelope = parseEnvelope(existing);
      if (envelope.envelopeDigest !== envelopeDigest) {
        return { kind: "conflict" } as const;
      }
      const lease = fanoutPhysicalLease(job);
      const physical = dependencies.physical.state(lease.slot);
      if (physical?.bindingDigest === lease.bindingDigest) {
        release = { binding: fanoutPhysicalBinding(job), lease };
      }
      return { kind: "duplicate", envelope } as const;
    }
    const taskRow = executeSqliteQueryTakeFirstSync(
      db,
      fanoutDb(db)
        .selectFrom("governor_tasks")
        .select("projection_json")
        .where("task_id", "=", job.taskId),
    );
    const task = taskRow ? parseTaskProjection(taskRow.projection_json) : null;
    if (task && isExternalChild(job.payload)) {
      const receipt = params.terminalReceiptId
        ? dependencies.receipts.resolve(params.terminalReceiptId, task.scopeKey)
        : null;
      const expectedPayload = {
        kind: "governor_external_child_terminal",
        childHandle: job.jobId,
        outcome: "completed",
        ...content,
      } as const;
      if (
        !receipt ||
        receipt.taskId !== job.taskId ||
        receipt.taskVersion !== job.taskVersion ||
        receipt.objectiveRevision !== job.objectiveRevision ||
        receipt.planVersion !== job.planVersion ||
        receipt.sourceKind !== "structured_external" ||
        receipt.observedAt > params.now ||
        governorDigest(receipt.payload) !== governorDigest(expectedPayload)
      ) {
        return { kind: "stale_worker" } as const;
      }
    }
    const staleTask =
      !task ||
      task.planVersion !== job.planVersion ||
      task.leaseEpoch !== job.leaseEpoch ||
      task.executionGeneration !== job.executionGeneration;
    const staleWorker =
      job.taskVersion !== params.taskVersion ||
      job.leaseEpoch !== params.leaseEpoch ||
      job.executionGeneration !== params.executionGeneration ||
      job.claimEpoch !== params.claimEpoch ||
      job.workerId !== params.workerId;
    const expired = job.leaseExpiresAt === undefined || job.leaseExpiresAt <= params.now;
    if (staleTask || staleWorker || expired || job.cancellationRequestedAt !== undefined) {
      if (
        job.state === "running" &&
        job.cancellationRequestedAt === undefined &&
        (staleTask || expired)
      ) {
        requestFanoutCancellation({
          db,
          coordinator: dependencies.physical,
          job,
          disposition: staleTask ? "cancel" : "requeue",
          now: params.now,
        });
      }
      return { kind: "stale_worker" } as const;
    }
    if (job.state !== "running") {
      return { kind: "stale_worker" } as const;
    }
    const lease = fanoutPhysicalLease(job);
    const physicalState = dependencies.physical.state(lease.slot);
    if (
      physicalState?.status !== "claimed" ||
      physicalState.generation !== lease.generation ||
      physicalState.bindingDigest !== lease.bindingDigest
    ) {
      return { kind: "stale_worker" } as const;
    }
    const envelope: GovernorFaninEnvelope = {
      envelopeId: `envelope_${job.jobId}`,
      jobId: job.jobId,
      taskId: job.taskId,
      planVersion: job.planVersion,
      round: job.round,
      taskVersion: params.taskVersion,
      leaseEpoch: params.leaseEpoch,
      executionGeneration: params.executionGeneration,
      claims: content.claims,
      evidence: content.evidence,
      unresolved: content.unresolved,
      envelopeDigest,
      createdAt: params.now,
    };
    executeSqliteQuerySync(
      db,
      fanoutDb(db).insertInto("governor_fanin_envelopes").values(bindEnvelope(envelope)),
    );
    const update = executeSqliteQuerySync(
      db,
      fanoutDb(db)
        .updateTable("governor_fanout_jobs")
        .set({
          state: "completed",
          completed_at: params.now,
          lease_expires_at: null,
          termination_outcome: "completed",
          termination_acknowledged_at: params.now,
          updated_at: params.now,
        })
        .where("job_id", "=", job.jobId)
        .where("state", "=", "running")
        .where("claim_epoch", "=", job.claimEpoch),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error(`Governor fanout completion lost its claim ${job.jobId}`);
    }
    release = { binding: fanoutPhysicalBinding(job), lease };
    return { kind: "completed", envelope } as const;
  }, dependencies.options);
  if (release && (result.kind === "completed" || result.kind === "duplicate")) {
    const released = dependencies.physical.complete(release.binding, release.lease);
    if (!released) {
      throw new Error(
        `Governor fanout physical completion was not durably released ${params.jobId}`,
      );
    }
  }
  return result;
}
