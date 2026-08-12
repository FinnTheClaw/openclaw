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
  governorFaninEnvelopeDigest,
  parseEnvelope,
  parseJob,
  replaceJob,
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
import type { GovernorTaskAuthorityStore } from "./task-authority.js";

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
    tasks: GovernorTaskAuthorityStore;
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
    const envelopeBase = {
      envelopeId: `envelope_${job.jobId}`,
      jobId: job.jobId,
      taskId: job.taskId,
      objectiveRevision: job.objectiveRevision,
      planVersion: job.planVersion,
      round: job.round,
      taskVersion: params.taskVersion,
      leaseEpoch: params.leaseEpoch,
      executionGeneration: params.executionGeneration,
      ...content,
    } as const;
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      fanoutDb(db)
        .selectFrom("governor_fanin_envelopes")
        .selectAll()
        .where("job_id", "=", job.jobId),
    );
    if (existing) {
      const envelope = parseEnvelope(existing);
      const expectedDigest = governorFaninEnvelopeDigest({
        ...envelopeBase,
        createdAt: envelope.createdAt,
      });
      if (envelope.envelopeDigest !== expectedDigest) {
        return { kind: "conflict" } as const;
      }
      const lease = fanoutPhysicalLease(job);
      const physical = dependencies.physical.state(lease.slot);
      if (physical?.bindingDigest === lease.bindingDigest) {
        release = { binding: fanoutPhysicalBinding(job), lease };
      }
      return { kind: "duplicate", envelope } as const;
    }
    const task = dependencies.tasks.loadCurrent(db, job.taskId);
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
      task.state !== "EXECUTING" ||
      task.taskVersion !== job.taskVersion ||
      task.objectiveRevision !== job.objectiveRevision ||
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
    const envelopeWithoutDigest = {
      ...envelopeBase,
      createdAt: params.now,
    };
    const envelope: GovernorFaninEnvelope = {
      ...envelopeWithoutDigest,
      envelopeDigest: governorFaninEnvelopeDigest(envelopeWithoutDigest),
    };
    executeSqliteQuerySync(
      db,
      fanoutDb(db).insertInto("governor_fanin_envelopes").values(bindEnvelope(envelope)),
    );
    const { leaseExpiresAt: _leaseExpiresAt, ...completed } = job;
    if (
      !replaceJob(db, job, {
        ...completed,
        state: "completed",
        completedAt: params.now,
        terminationOutcome: "completed",
        terminationAcknowledgedAt: params.now,
        updatedAt: params.now,
      })
    ) {
      throw new Error("GOVERNOR_FANOUT_COMPLETION_CLAIM_LOST");
    }
    release = { binding: fanoutPhysicalBinding(job), lease };
    return { kind: "completed", envelope } as const;
  }, dependencies.options);
  if (release && (result.kind === "completed" || result.kind === "duplicate")) {
    const released = dependencies.physical.complete(release.binding, release.lease);
    if (!released) {
      throw new Error("GOVERNOR_FANOUT_PHYSICAL_RELEASE_FAILED");
    }
  }
  return result;
}
