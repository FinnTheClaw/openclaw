import { toErrorObject } from "../../infra/errors.js";
import type { MemoryGovernorBackend } from "../../plugins/memory-state.js";
import type { GovernorTrustedMemoryAuthority } from "../../security/governor-host-readonly.js";
// Joins scoped memory records to store-verified contradiction and repair evidence.
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { loadCurrentGovernorEvidence } from "./current-evidence.js";
import { toGovernorBackendFact } from "./memory-backend-binding.js";
import { normalizeGovernorFactKey } from "./memory-contradiction-policy.js";
import { GovernorMemoryContradictionStore } from "./memory-contradiction-store.js";
import { GovernorMemoryStore, type GovernorMemoryRecord } from "./memory-integrity.js";
import { evaluateGovernorMemoryReinvestigation } from "./memory-reinvestigation.js";
import type { GovernorMemoryRemediation } from "./memory-remediation.js";
import type { GovernorMemoryRepairFence } from "./memory-repair-state-store.js";
import type { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import type { GovernorStoreQueries } from "./store-queries.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";
import {
  canonicalGovernorScopeKey,
  type GovernorIdentityContext,
  type GovernorTaskId,
  type GovernorTaskScope,
} from "./types.js";

export class GovernorMemorySubsystem extends GovernorMemoryStore {
  readonly #contradictions: GovernorMemoryContradictionStore;
  readonly #evidenceAdmissions: GovernorEvidenceAdmissionStore;
  readonly #queries: GovernorStoreQueries;
  readonly #identity: GovernorIdentityContext;
  readonly backend?: MemoryGovernorBackend;
  #backendTail: Promise<void> = Promise.resolve();
  #backendError: unknown;

  constructor(params: {
    options: OpenClawStateDatabaseOptions;
    identity: GovernorIdentityContext;
    evidenceAdmissions: GovernorEvidenceAdmissionStore;
    queries: GovernorStoreQueries;
    memoryAuthority: GovernorTrustedMemoryAuthority;
    taskAuthority: GovernorTaskAuthorityStore;
    backend?: MemoryGovernorBackend;
  }) {
    super({
      options: params.options,
      identity: params.identity,
      evidenceAdmissions: params.evidenceAdmissions,
      queries: params.queries,
      memoryAuthority: params.memoryAuthority,
      taskAuthority: params.taskAuthority,
    });
    this.#identity = params.identity;
    this.backend = params.backend;
    this.#evidenceAdmissions = params.evidenceAdmissions;
    this.#queries = params.queries;
    this.#contradictions = new GovernorMemoryContradictionStore({
      options: params.options,
      evidenceAdmissions: params.evidenceAdmissions,
      memoryAuthority: params.memoryAuthority,
      taskAuthority: params.taskAuthority,
    });
  }

  #verifiedEvidence(taskId: GovernorTaskId, evidenceId: string) {
    return loadCurrentGovernorEvidence({
      admissions: this.#evidenceAdmissions,
      queries: this.#queries,
      taskId,
      evidenceId,
    });
  }

  #enqueueBackend(work: () => Promise<void>): void {
    if (!this.backend) {
      return;
    }
    this.#backendTail = this.#backendTail.then(work).catch((error: unknown) => {
      this.#backendError ??= error;
    });
  }

  async flushBackend(): Promise<void> {
    await this.#backendTail;
    if (this.#backendError !== undefined) {
      throw toErrorObject(this.#backendError, "Governor memory backend failed");
    }
  }

  #queueBackendRetirement(memory: GovernorMemoryRecord, now: number, force = false): void {
    if (
      !this.backend?.retire ||
      (!force && (memory.status === "verified" || memory.status === "candidate"))
    ) {
      return;
    }
    this.#enqueueBackend(async () => {
      await this.backend!.retire!({
        agentId: "governor",
        scope: memory.scopeKey,
        scopeKey: memory.scopeKey,
        factKey: memory.factKey,
        staleMemoryId: memory.memoryId,
        reason: "operator_requested",
        now,
      });
    });
  }

  async recallBackend(params: {
    scope: GovernorTaskScope;
    query: string;
    limit: number;
    now: number;
  }) {
    await this.flushBackend();
    if (!this.backend) {
      return [];
    }
    const scopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    return this.backend.recall({
      agentId: "governor",
      scopes: [scopeKey],
      scopeKeys: [scopeKey],
      query: params.query,
      limit: params.limit,
      now: params.now,
    });
  }

  override promoteVerified(params: Parameters<GovernorMemoryStore["promoteVerified"]>[0]) {
    if (this.#backendError !== undefined) {
      throw toErrorObject(this.#backendError, "Governor memory backend failed");
    }
    const result = super.promoteVerified(params);
    if (result.stored && this.backend) {
      const fact = toGovernorBackendFact(result.memory);
      this.#enqueueBackend(async () => {
        await this.backend!.admit({ fact, now: params.now });
      });
    }
    return result;
  }

  override quarantine(params: Parameters<GovernorMemoryStore["quarantine"]>[0]) {
    const before = super
      .retrieveAudit({ scope: params.scope })
      .find((memory) => memory.memoryId === params.memoryId);
    const result = super.quarantine(params);
    if (result && before) {
      this.#queueBackendRetirement(before, params.now, true);
    }
    return result;
  }

  override retrieveAudit(params: Parameters<GovernorMemoryStore["retrieveAudit"]>[0]) {
    const records = super.retrieveAudit(params);
    for (const memory of records) {
      this.#queueBackendRetirement(memory, memory.updatedAt);
    }
    return records;
  }

  override forget(params: Parameters<GovernorMemoryStore["forget"]>[0]) {
    const before = super
      .retrieveAudit({ scope: params.scope })
      .find((memory) => memory.memoryId === params.memoryId);
    const result = super.forget(params);
    if (result.status === "deleted" && before) {
      this.#queueBackendRetirement(before, params.now, true);
    }
    return result;
  }

  resolveContradiction(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    staleMemoryId: string;
    contradictionClass: string;
    executionFence: GovernorMemoryRepairFence;
    freshnessExpiresAt?: number;
    now: number;
  }) {
    const resolution = this.#contradictions.resolve({
      taskId: params.taskId,
      evidenceId: params.evidenceId,
      staleMemoryId: params.staleMemoryId,
      contradictionClass: params.contradictionClass,
      executionFence: params.executionFence,
      ...(params.freshnessExpiresAt === undefined
        ? {}
        : { freshnessExpiresAt: params.freshnessExpiresAt }),
      now: params.now,
    });
    if ((resolution.kind === "retired" || resolution.kind === "duplicate") && this.backend) {
      const replacement = toGovernorBackendFact(resolution.replacement);
      this.#enqueueBackend(async () => {
        await this.backend!.invalidate({
          agentId: "governor",
          scope: resolution.retired.scopeKey,
          scopeKey: resolution.retired.scopeKey,
          factKey: resolution.retired.factKey,
          staleMemoryId: resolution.retired.memoryId,
          sourceEvidenceId: replacement.sourceEvidenceId,
          sourceEvidenceDigest: replacement.sourceEvidenceDigest,
          sourceObservedAt: replacement.observedAt,
          reason: "contradicted_by_newer_evidence",
          replacement,
          now: params.now,
        });
      });
    }
    return resolution;
  }

  loadRemediation(fingerprint: string): GovernorMemoryRemediation | null {
    return this.#contradictions.load(fingerprint);
  }

  listRemediations(scope: GovernorTaskScope): GovernorMemoryRemediation[] {
    return this.#contradictions.list(canonicalGovernorScopeKey(scope, this.#identity));
  }

  reinvestigationDecision(params: {
    fingerprint: string;
    scope: GovernorTaskScope;
    taskId?: GovernorTaskId;
    evidenceId?: string;
    operatorRequested?: boolean;
    now: number;
  }) {
    if (Boolean(params.taskId) !== Boolean(params.evidenceId)) {
      throw new Error("Governor reinvestigation evidence requires both task and evidence IDs");
    }
    const remediation = this.#contradictions.load(params.fingerprint);
    if (!remediation) {
      throw new Error("Governor memory remediation not found");
    }
    const requestedScopeKey = canonicalGovernorScopeKey(params.scope, this.#identity);
    const replacement =
      remediation.replacementMemoryId && requestedScopeKey === remediation.scopeKey
        ? (this.retrieveAudit({ scope: params.scope }).find(
            (memory) => memory.memoryId === remediation.replacementMemoryId,
          ) ?? null)
        : null;
    return evaluateGovernorMemoryReinvestigation({
      remediation,
      replacement,
      requestedScopeKey,
      ...(params.taskId && params.evidenceId
        ? {
            evidence: this.#verifiedEvidence(params.taskId, params.evidenceId),
          }
        : {}),
      ...(params.operatorRequested === undefined
        ? {}
        : { operatorRequested: params.operatorRequested }),
      now: params.now,
    });
  }

  updateRepairState(params: {
    fingerprint: string;
    status: "repairing" | "blocked";
    blockedReason?: string;
    now: number;
    guard: {
      taskId: GovernorTaskId;
      executionFence: GovernorMemoryRepairFence;
      expectedStatus: GovernorMemoryRemediation["status"];
      expectedUpdatedAt: number;
    };
  }): GovernorMemoryRemediation | null {
    return this.#contradictions.updateRepairState(params);
  }

  requeueRepair(params: {
    fingerprint: string;
    now: number;
    guard: {
      taskId: GovernorTaskId;
      executionFence: GovernorMemoryRepairFence;
      expectedStatus: GovernorMemoryRemediation["status"];
      expectedUpdatedAt: number;
    };
  }) {
    return this.#contradictions.requeueRepair(params);
  }

  verifyRepair(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    fingerprint: string;
    now: number;
    guard: {
      taskId: GovernorTaskId;
      executionFence: GovernorMemoryRepairFence;
      expectedStatus: GovernorMemoryRemediation["status"];
      expectedUpdatedAt: number;
    };
  }): GovernorMemoryRemediation | null {
    return this.#contradictions.verifyRepair({
      taskId: params.taskId,
      evidenceId: params.evidenceId,
      fingerprint: params.fingerprint,
      now: params.now,
      guard: params.guard,
    });
  }

  override retrieve(params: { scope: GovernorTaskScope; now: number }): GovernorMemoryRecord[] {
    if (this.#backendError !== undefined) {
      throw toErrorObject(this.#backendError, "Governor memory backend failed");
    }
    const records = super.retrieve(params);
    if (this.backend?.retire) {
      for (const memory of super.retrieveAudit({ scope: params.scope })) {
        this.#queueBackendRetirement(memory, params.now);
      }
    }
    return records;
  }

  activeReplacement(params: {
    scope: GovernorTaskScope;
    factKey: string;
    now: number;
  }): GovernorMemoryRecord | null {
    const factKey = normalizeGovernorFactKey(params.factKey);
    return (
      this.retrieve({ scope: params.scope, now: params.now }).find(
        (memory) => memory.factKey === factKey && memory.status === "verified",
      ) ?? null
    );
  }
}
