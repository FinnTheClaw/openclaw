// Verifies host-broker-signed grants. Task-facing code can only reference opaque IDs.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  isTrustedGovernorApprovalResolver,
  type GovernorTrustedApprovalResolver,
  type HostGovernorApprovalReceiptId,
  type HostGovernorApprovalRevocationId,
} from "../../security/governor-host-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import { isOpaqueGovernorReference, type GovernorTaskProjection } from "./types.js";

type ApprovalDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_approval_grants" | "governor_approval_epochs"
>;
type ApprovalRow = Selectable<OpenClawStateKyselyDatabase["governor_approval_grants"]>;

type GovernorApprovalTaskFence = Pick<
  GovernorTaskProjection,
  "taskId" | "scopeKey" | "objectiveRevision"
>;

type GovernorApprovalGrant = {
  grantId: string;
  taskId: string;
  scopeKey: string;
  objectiveRevision: number;
  capability: string;
  capabilityVersion: string;
  canonicalTarget: string;
  issuerId: string;
  expiresAt: number;
  approvalEpoch: number;
  authorityKeyId: string;
  authorityVersion: number;
  authoritySignature: string;
  revokedAt?: number;
  createdAt: number;
};

export type GovernorApprovalStatus = "approved" | "missing" | "stale" | "revoked";

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<ApprovalDatabase>(db);
}

function primaryEpoch(db: DatabaseSync, scopeKey: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbx(db)
      .selectFrom("governor_approval_epochs")
      .select("epoch")
      .where("scope_key", "=", scopeKey),
  );
  return normalizeSqliteNumber(row?.epoch ?? null) ?? 0;
}

function parseGrant(row: ApprovalRow): GovernorApprovalGrant {
  const grant: GovernorApprovalGrant = {
    grantId: row.grant_id,
    taskId: row.task_id,
    scopeKey: row.scope_key,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    capability: row.capability,
    capabilityVersion: row.capability_version,
    canonicalTarget: row.canonical_target,
    issuerId: row.issuer_id,
    expiresAt: normalizeSqliteNumber(row.expires_at) ?? 0,
    approvalEpoch: normalizeSqliteNumber(row.approval_epoch) ?? -1,
    authorityKeyId: row.authority_key_id,
    authorityVersion: normalizeSqliteNumber(row.authority_version) ?? 0,
    authoritySignature: row.authority_signature,
    ...(row.revoked_at == null ? {} : { revokedAt: normalizeSqliteNumber(row.revoked_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
  };
  assertGovernorPersistedJson("log", grant);
  if (
    !isOpaqueGovernorReference(grant.scopeKey) ||
    !isOpaqueGovernorReference(grant.canonicalTarget)
  ) {
    throw new Error("Persisted governor approval identity is not host-opaque");
  }
  return grant;
}

function bindGrant(grant: GovernorApprovalGrant): Insertable<ApprovalRow> {
  assertGovernorPersistedJson("log", grant);
  if (
    !isOpaqueGovernorReference(grant.scopeKey) ||
    !isOpaqueGovernorReference(grant.canonicalTarget)
  ) {
    throw new Error("Governor approval identity is not host-opaque");
  }
  return {
    grant_id: grant.grantId,
    task_id: grant.taskId,
    scope_key: grant.scopeKey,
    objective_revision: grant.objectiveRevision,
    capability: grant.capability,
    capability_version: grant.capabilityVersion,
    canonical_target: grant.canonicalTarget,
    issuer_id: grant.issuerId,
    expires_at: grant.expiresAt,
    revoked_at: grant.revokedAt ?? null,
    created_at: grant.createdAt,
    approval_epoch: grant.approvalEpoch,
    authority_key_id: grant.authorityKeyId,
    authority_version: grant.authorityVersion,
    authority_signature: grant.authoritySignature,
  };
}

/**
 * This store deliberately has no issue/revoke methods. The host broker owns
 * mutation capabilities; this task-side object only admits its opaque receipts
 * and verifies durable grants.
 */
export class GovernorApprovalGrantStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #resolver: GovernorTrustedApprovalResolver;

  constructor(params: {
    stateDir?: string;
    options?: OpenClawStateDatabaseOptions;
    approvalResolver: GovernorTrustedApprovalResolver;
  }) {
    if (!isTrustedGovernorApprovalResolver(params.approvalResolver)) {
      throw new Error("Governor approval store requires a trusted host approval resolver");
    }
    this.#options =
      params.options ??
      (params.stateDir ? { env: { OPENCLAW_STATE_DIR: params.stateDir } } : { env: {} });
    this.#resolver = params.approvalResolver;
  }

  currentEpoch(scopeKey: string): number {
    const { db } = openOpenClawStateDatabase(this.#options);
    return primaryEpoch(db, scopeKey);
  }

  admitAuthenticatedApproval(params: {
    task: GovernorTaskProjection;
    receiptId: HostGovernorApprovalReceiptId;
    now: number;
  }): string {
    assertGovernorPersistedJson("log", params);
    const receipt = this.#resolver.resolveApproval(params.receiptId, params.task.scopeKey);
    if (!receipt || receipt.expiresAt <= params.now || receipt.approvalEpoch < 0) {
      throw new Error("Governor approval receipt is invalid or expired");
    }
    if (
      receipt.taskId !== params.task.taskId ||
      receipt.objectiveRevision !== params.task.objectiveRevision
    ) {
      throw new Error("Governor approval receipt is stale for this task revision");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      // The write lock orders this recheck against host revocation. A
      // ledger-first revocation crash must not leave a task-side stale grant.
      if (!this.#resolver.verifyApprovalReceiptCurrent(receipt)) {
        throw new Error("Governor approval receipt was revoked before admission");
      }
      const current = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_approval_epochs")
          .selectAll()
          .where("scope_key", "=", params.task.scopeKey),
      );
      if ((normalizeSqliteNumber(current?.epoch ?? null) ?? 0) !== receipt.approvalEpoch) {
        throw new Error("Governor approval receipt epoch is stale");
      }
      const grant: GovernorApprovalGrant = {
        grantId: receipt.grantId,
        taskId: params.task.taskId,
        scopeKey: params.task.scopeKey,
        objectiveRevision: params.task.objectiveRevision,
        capability: receipt.capability,
        capabilityVersion: receipt.capabilityVersion,
        canonicalTarget: receipt.canonicalTargetOpaque,
        issuerId: receipt.id,
        expiresAt: receipt.expiresAt,
        approvalEpoch: receipt.approvalEpoch,
        authorityKeyId: receipt.grantKeyId,
        authorityVersion: 1,
        authoritySignature: receipt.grantSignature,
        createdAt: params.now,
      };
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_approval_grants").values(bindGrant(grant)),
      );
      return grant.grantId;
    }, this.#options);
  }

  status(
    task: GovernorTaskProjection,
    proposal: GovernorActionProposal,
    now: number,
  ): GovernorApprovalStatus {
    const { db } = openOpenClawStateDatabase(this.#options);
    return this.statusWithinTransaction(db, task, proposal, now);
  }

  /**
   * Revalidates an approval while the caller owns the shared state write lock.
   * The host ledger is consulted by the resolver; task-side epoch and grant
   * state are read from the same SQLite transaction that claims the action.
   */
  statusWithinTransaction(
    db: DatabaseSync,
    task: GovernorApprovalTaskFence,
    proposal: GovernorActionProposal,
    now: number,
  ): GovernorApprovalStatus {
    if (!proposal.approvalGrantId) {
      return "missing";
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_approval_grants")
        .selectAll()
        .where("grant_id", "=", proposal.approvalGrantId),
    );
    if (!row) {
      return "missing";
    }
    const grant = parseGrant(row);
    if (!this.#resolver.verifyApprovalGrant(grant, proposal.canonicalTarget)) {
      return "revoked";
    }
    if (
      grant.revokedAt !== undefined ||
      grant.expiresAt <= now ||
      primaryEpoch(db, grant.scopeKey) !== grant.approvalEpoch
    ) {
      return "revoked";
    }
    return grant.taskId === task.taskId &&
      grant.scopeKey === task.scopeKey &&
      grant.objectiveRevision === task.objectiveRevision &&
      grant.capability === proposal.capability &&
      grant.capabilityVersion === proposal.capabilityVersion
      ? "approved"
      : "stale";
  }

  applyAuthenticatedRevocation(params: {
    grantId: string;
    receiptId: HostGovernorApprovalRevocationId;
  }): boolean {
    assertGovernorPersistedJson("log", params);
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_approval_grants")
        .selectAll()
        .where("grant_id", "=", params.grantId),
    );
    if (!row) {
      return false;
    }
    const grant = parseGrant(row);
    const receipt = this.#resolver.resolveRevocation(params.receiptId, grant.scopeKey);
    return (
      receipt?.grantId === grant.grantId &&
      grant.revokedAt !== undefined &&
      this.currentEpoch(grant.scopeKey) > grant.approvalEpoch
    );
  }
}
