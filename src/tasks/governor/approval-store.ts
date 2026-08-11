// Stores host-authenticated approvals; proposals can reference opaque grant IDs only.
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
import { canonicalGovernorJson } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import type { GovernorActionProposal } from "./tool-outcome.js";
import { opaqueGovernorReference, type GovernorTaskProjection } from "./types.js";

type ApprovalDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "governor_approval_grants" | "governor_approval_epochs"
>;
type ApprovalRow = Selectable<OpenClawStateKyselyDatabase["governor_approval_grants"]>;

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

function approvalKey(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCLAW_GOVERNOR_APPROVAL_KEY?.trim();
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "test") {
    return "governor-test-approval-key";
  }
  throw new Error("OPENCLAW_GOVERNOR_APPROVAL_KEY is required for enabled approvals");
}

class GovernorHostApprovalAuthority {
  readonly #key: string;
  readonly #keyId: string;
  readonly #issuers: ReadonlySet<string>;

  private constructor(key: string, keyId: string, issuers: Iterable<string>) {
    this.#key = key;
    this.#keyId = keyId;
    this.#issuers = new Set(issuers);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GovernorHostApprovalAuthority {
    const configured = env.OPENCLAW_GOVERNOR_APPROVER_IDS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const issuers = configured?.length
      ? configured
      : env.NODE_ENV === "test"
        ? ["test-host-approver"]
        : [];
    if (!issuers.length) {
      throw new Error("OPENCLAW_GOVERNOR_APPROVER_IDS is required");
    }
    return new GovernorHostApprovalAuthority(
      approvalKey(env),
      env.OPENCLAW_GOVERNOR_APPROVAL_KEY_ID?.trim() || "v1",
      issuers,
    );
  }

  assertIssuer(issuerId: string): void {
    if (!this.#issuers.has(issuerId)) {
      throw new Error("Governor approval issuer was not host-authenticated");
    }
  }

  get keyId(): string {
    return this.#keyId;
  }

  sign(grant: Omit<GovernorApprovalGrant, "authoritySignature">): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson(grant))
      .digest("hex");
  }

  assertVerified(grant: GovernorApprovalGrant): void {
    if (grant.authorityVersion !== 1 || grant.authorityKeyId !== this.#keyId) {
      throw new Error("Governor approval authority key/version is not accepted");
    }
    const { authoritySignature, ...unsigned } = grant;
    const expected = this.sign(unsigned);
    if (
      authoritySignature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(authoritySignature), Buffer.from(expected))
    ) {
      throw new Error("Governor approval signature is invalid");
    }
  }
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
    approvalEpoch: normalizeSqliteNumber(row.approval_epoch) ?? -1,
    authorityKeyId: row.authority_key_id,
    authorityVersion: normalizeSqliteNumber(row.authority_version) ?? 0,
    authoritySignature: row.authority_signature,
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
    approval_epoch: grant.approvalEpoch,
    authority_key_id: grant.authorityKeyId,
    authority_version: grant.authorityVersion,
    authority_signature: grant.authoritySignature,
  };
}

export class GovernorApprovalGrantStore {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #authority: GovernorHostApprovalAuthority;

  constructor(params: { stateDir?: string } = {}) {
    this.#options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    initializeGovernorStateSchema(this.#options);
    this.#authority = GovernorHostApprovalAuthority.fromEnvironment();
  }

  issue(params: {
    task: GovernorTaskProjection;
    issuerId: string;
    capability: string;
    capabilityVersion: string;
    canonicalTarget: string;
    expiresAt: number;
    now: number;
  }): GovernorApprovalGrant {
    const safe = assertGovernorBoundarySafe("log", params) as typeof params;
    if (safe.expiresAt <= safe.now) {
      throw new Error("Governor approval grant must have a future expiry");
    }
    this.#authority.assertIssuer(safe.issuerId);
    return runOpenClawStateWriteTransaction(({ db }) => {
      const current = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db)
          .selectFrom("governor_approval_epochs")
          .selectAll()
          .where("scope_key", "=", safe.task.scopeKey),
      );
      const approvalEpoch = normalizeSqliteNumber(current?.epoch) ?? 0;
      const unsigned: Omit<GovernorApprovalGrant, "authoritySignature"> = {
        grantId: `ggrant_${crypto.randomUUID()}`,
        taskId: safe.task.taskId,
        scopeKey: safe.task.scopeKey,
        objectiveRevision: safe.task.objectiveRevision,
        capability: safe.capability,
        capabilityVersion: safe.capabilityVersion,
        canonicalTarget: opaqueGovernorReference("approval-target", safe.canonicalTarget),
        issuerId: opaqueGovernorReference("approval-issuer", safe.issuerId),
        expiresAt: safe.expiresAt,
        approvalEpoch,
        authorityKeyId: this.#authority.keyId,
        authorityVersion: 1,
        createdAt: safe.now,
      };
      const grant = { ...unsigned, authoritySignature: this.#authority.sign(unsigned) };
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
    try {
      this.#authority.assertVerified(grant);
    } catch {
      return "revoked";
    }
    const epoch = executeSqliteQueryTakeFirstSync(
      db,
      dbx(db)
        .selectFrom("governor_approval_epochs")
        .selectAll()
        .where("scope_key", "=", grant.scopeKey),
    );
    if (
      grant.revokedAt !== undefined ||
      grant.expiresAt <= now ||
      (normalizeSqliteNumber(epoch?.epoch) ?? 0) !== grant.approvalEpoch
    ) {
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
      const row = executeSqliteQueryTakeFirstSync(
        db,
        dbx(db).selectFrom("governor_approval_grants").selectAll().where("grant_id", "=", grantId),
      );
      if (!row) {
        return false;
      }
      const grant = parseGrant(row);
      executeSqliteQuerySync(
        db,
        dbx(db)
          .insertInto("governor_approval_epochs")
          .values({ scope_key: grant.scopeKey, epoch: grant.approvalEpoch + 1, updated_at: now })
          .onConflict((c) =>
            c.column("scope_key").doUpdateSet({ epoch: grant.approvalEpoch + 1, updated_at: now }),
          ),
      );
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
