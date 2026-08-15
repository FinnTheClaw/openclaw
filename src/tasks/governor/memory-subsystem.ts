import type { MemoryGovernorBackend } from "../../plugins/memory-state.js";
import type { GovernorTrustedMemoryAuthority } from "../../security/governor-host-readonly.js";
// Joins scoped memory records to store-verified contradiction and repair evidence.
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { loadCurrentGovernorEvidence } from "./current-evidence.js";
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

  resolveContradiction(params: {
    taskId: GovernorTaskId;
    evidenceId: string;
    staleMemoryId: string;
    contradictionClass: string;
    executionFence: GovernorMemoryRepairFence;
    freshnessExpiresAt?: number;
    now: number;
  }) {
    return this.#contradictions.resolve({
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
