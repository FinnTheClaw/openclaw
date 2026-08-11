// Stores host-authenticated approvals; model proposals may only reference their opaque IDs.
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import { opaqueGovernorReference, type GovernorTaskProjection } from "./types.js";

type ApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "governor_approval_grants">;
type ApprovalRow = Selectable<OpenClawStateKyselyDatabase["governor_approval_grants"]>;

export type GovernorApprovalAuthority = {
  verifyAuthenticatedApproval: (params: {
    task: GovernorTaskProjection;
    issuerId: string;
    now: number;
  }) => boolean;
};

export type GovernorApprovalGrant = {
  grantId: string;
  taskId: string;
  scopeKey: string;
  objectiveRevision: number;
  capability: string;
  capabilityVersion: string;
  canonicalTarget: string;
  issuerId: string;
  expiresAt: number;
  revokedAt?: number;
  createdAt: number;
};

export type GovernorApprovalStatus = "approved" | "missing" | "stale" | "revoked";

function dbx(db: DatabaseSync) {
  return getNodeSqliteKysely<ApprovalDatabase>(db);
}

function parseGrant(row: ApprovalRow): GovernorApprovalGrant {
  return {
    grantId: row.grant_id,
    taskId: row.task_id,
    scopeKey: row.scope_key,
    objectiveRevision: normalizeSqliteNumber(row.objective_revision) ?? 0,
    capability: row.capability,
    capabilityVersion: row.capability_version,
    canonicalTarget: row.canonical_target,
    issuerId: row.issuer_id,
    expiresAt: normalizeSqliteNumber(row.expires_at) ?? 0,
    ...(row.revoked_at == null ? {} : { revokedAt: normalizeSqliteNumber(row.revoked_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
  };
}

function bindGrant(grant: GovernorApprovalGrant): Insertable<ApprovalRow> {
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
  };
}

export class GovernorApprovalGrantStore {
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
  }

  issue(params: {
    task: GovernorTaskProjection;
    issuerId: string;
    capability: string;
    capabilityVersion: string;
    canonicalTarget: string;
    expiresAt: number;
    authority: GovernorApprovalAuthority;
    now: number;
  }): GovernorApprovalGrant {
    const safe = assertGovernorBoundarySafe("log", {
      issuerId: params.issuerId,
      capability: params.capability,
      capabilityVersion: params.capabilityVersion,
      canonicalTarget: params.canonicalTarget,
    }) as {
      issuerId: string;
      capability: string;
      capabilityVersion: string;
      canonicalTarget: string;
    };
    if (params.expiresAt <= params.now) {
      throw new Error("Governor approval grant must have a future expiry");
    }
    if (
      !params.authority.verifyAuthenticatedApproval({
        task: params.task,
        issuerId: safe.issuerId,
        now: params.now,
      })
    ) {
      throw new Error("Governor approval issuer was not authenticated");
    }
    const grant: GovernorApprovalGrant = {
      grantId: `ggrant_${crypto.randomUUID()}`,
      taskId: params.task.taskId,
      scopeKey: params.task.scopeKey,
      objectiveRevision: params.task.objectiveRevision,
      capability: safe.capability,
      capabilityVersion: safe.capabilityVersion,
      canonicalTarget: opaqueGovernorReference("approval-target", safe.canonicalTarget),
      issuerId: opaqueGovernorReference("approval-issuer", safe.issuerId),
      expiresAt: params.expiresAt,
      createdAt: params.now,
    };
    return runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        dbx(db).insertInto("governor_approval_grants").values(bindGrant(grant)),
      );
      return grant;
    }, this.#options);
  }

  status(
    task: GovernorTaskProjection,
    proposal: GovernorActionProposal,
    now: number,
  ): GovernorApprovalStatus {
    if (!proposal.approvalGrantId) {
      return "missing";
    }
    const { db } = openOpenClawStateDatabase(this.#options);
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
    if (grant.revokedAt !== undefined || grant.expiresAt <= now) {
      return "revoked";
    }
    return grant.taskId === task.taskId &&
      grant.scopeKey === task.scopeKey &&
      grant.objectiveRevision === task.objectiveRevision &&
      grant.capability === proposal.capability &&
      grant.capabilityVersion === proposal.capabilityVersion &&
      grant.canonicalTarget === opaqueGovernorReference("approval-target", proposal.canonicalTarget)
      ? "approved"
      : "stale";
  }

  revoke(grantId: string, now: number): boolean {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const update = executeSqliteQuerySync(
        db,
        dbx(db)
          .updateTable("governor_approval_grants")
          .set({ revoked_at: now })
          .where("grant_id", "=", grantId)
          .where("revoked_at", "is", null),
      );
      return update.numAffectedRows === 1n;
    }, this.#options);
  }
}
