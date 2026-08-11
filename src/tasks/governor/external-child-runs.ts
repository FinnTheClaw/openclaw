// Adapts ordinary OpenClaw child runs onto the durable fanout/completion authority.
import {
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedReceiptResolver,
  type HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorFanoutCompletion, GovernorFanoutJob } from "./fanout-codec.js";
import type { CompleteFanoutParams } from "./fanout-completion.js";
import { GovernorFanoutStore } from "./fanout.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskProjection } from "./types.js";

type ChildRegistration = Readonly<{
  kind: "governor_external_child_registration";
  childRunId: string;
  round: number;
  priority: number;
  request: GovernorJsonValue;
}>;

function registration(value: GovernorJsonValue): ChildRegistration {
  assertGovernorPersistedJson("session", value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Governor child registration receipt is invalid");
  }
  const input = value as Record<string, GovernorJsonValue>;
  if (
    Object.keys(input).toSorted().join(",") !== "childRunId,kind,priority,request,round" ||
    input.kind !== "governor_external_child_registration" ||
    typeof input.childRunId !== "string" ||
    !input.childRunId.trim() ||
    !Number.isSafeInteger(input.round) ||
    Number(input.round) < 0 ||
    !Number.isSafeInteger(input.priority)
  ) {
    throw new Error("Governor child registration receipt is invalid");
  }
  return input as unknown as ChildRegistration;
}

export class GovernorExternalChildRunStore {
  readonly #fanout: GovernorFanoutStore;
  readonly #receipts: GovernorTrustedReceiptResolver;

  constructor(params: {
    fanout: GovernorFanoutStore;
    receiptResolver: GovernorTrustedReceiptResolver;
  }) {
    if (!isTrustedGovernorReceiptResolver(params.receiptResolver)) {
      throw new Error("Governor child runs require a trusted host receipt resolver");
    }
    this.#fanout = params.fanout;
    this.#receipts = params.receiptResolver;
  }

  register(params: {
    task: GovernorTaskProjection;
    receiptId: HostGovernorReceiptId;
    now: number;
  }): GovernorFanoutJob {
    const receipt = this.#receipts.resolve(params.receiptId, params.task.scopeKey);
    if (
      !receipt ||
      receipt.taskId !== params.task.taskId ||
      receipt.taskVersion !== params.task.taskVersion ||
      receipt.objectiveRevision !== params.task.objectiveRevision ||
      receipt.planVersion !== params.task.planVersion ||
      receipt.sourceKind !== "structured_external" ||
      receipt.observedAt > params.now
    ) {
      throw new Error("Governor child registration receipt is stale or invalid");
    }
    const input = registration(receipt.payload);
    const request = assertGovernorBoundarySafe("session", input.request);
    const childIdentityDigest = governorDigest({
      sourceIdentity: receipt.sourceIdentity,
      childRunId: input.childRunId,
    });
    const jobId = `gchild_${governorDigest({
      taskId: params.task.taskId,
      objectiveRevision: params.task.objectiveRevision,
      planVersion: params.task.planVersion,
      executionGeneration: params.task.executionGeneration,
      childIdentityDigest,
    }).slice(0, 40)}`;
    return this.#fanout.enqueue({
      jobId,
      task: params.task,
      round: input.round,
      priority: input.priority,
      fanoutGroup: "external-child",
      payload: {
        kind: "governor_external_child",
        childRunDigest: childIdentityDigest,
        registrationDigest: governorDigest(receipt.payload),
        request,
      },
      now: params.now,
    });
  }

  complete(
    params: CompleteFanoutParams & { terminalReceiptId: HostGovernorReceiptId },
  ): GovernorFanoutCompletion {
    return this.#fanout.complete(params);
  }

  markUnknown(jobId: string, now: number): boolean {
    return this.#fanout.requestRetirement(jobId, "cancel", now);
  }

  list(taskId: GovernorTaskProjection["taskId"]): GovernorFanoutJob[] {
    return this.#fanout
      .listJobs(taskId)
      .filter(
        (job) =>
          typeof job.payload === "object" &&
          !Array.isArray(job.payload) &&
          job.payload?.kind === "governor_external_child",
      );
  }
}
