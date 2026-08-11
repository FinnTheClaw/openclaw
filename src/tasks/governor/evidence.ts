// Admits only current, same-scope, externally sourced evidence.
import crypto from "node:crypto";
import type { GovernorJsonValue } from "./canonical-json.js";
import { canonicalGovernorJson, governorDigest } from "./canonical-json.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import {
  opaqueGovernorReference,
  type GovernorTaskId,
  type GovernorTaskProjection,
} from "./types.js";

declare const governorOpaqueEvidenceSourceRefBrand: unique symbol;

/** A keyed, non-reversible reference that is safe to retain with evidence. */
export type OpaqueEvidenceSourceRef = string & {
  readonly [governorOpaqueEvidenceSourceRefBrand]: true;
};

const OPAQUE_EVIDENCE_SOURCE_REF = /^oesr_[a-f0-9]{64}$/u;

export type GovernorEvidenceSourceKind =
  | "tool"
  | "structured_external"
  | "authenticated_user"
  | "memory_candidate"
  | "assistant_text"
  | "hidden_reasoning";

export type GovernorEvidenceCandidate = {
  evidenceId: string;
  taskId: GovernorTaskId;
  criterionId: string;
  sourceKind: GovernorEvidenceSourceKind;
  sourceIdentity: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  scopeKey: string;
  observedAt: number;
  payload: GovernorJsonValue;
  evidenceDigest: string;
  predicate?: string;
  value?: GovernorJsonValue;
};

export type GovernorEvidenceRecord = Omit<
  GovernorEvidenceCandidate,
  "sourceIdentity" | "predicate" | "value"
> & {
  sourceIdentity: OpaqueEvidenceSourceRef;
  predicate: string;
  value: GovernorJsonValue;
  semanticDigest: string;
  admissibility: "admitted";
  createdAt: number;
  invalidatedAt?: number;
  admissionKeyId: string;
  admissionVersion: number;
  admissionSignature: string;
};

export function isOpaqueEvidenceSourceRef(value: string): value is OpaqueEvidenceSourceRef {
  return OPAQUE_EVIDENCE_SOURCE_REF.test(value);
}

export function assertOpaqueEvidenceSourceRef(value: string): OpaqueEvidenceSourceRef {
  if (!isOpaqueEvidenceSourceRef(value)) {
    throw new Error("Governor evidence source identity must be an opaque keyed reference");
  }
  return value;
}

function opaqueEvidenceSourceRef(
  sourceKind: GovernorEvidenceSourceKind,
  sourceIdentity: string,
): OpaqueEvidenceSourceRef {
  return `oesr_${opaqueGovernorReference(`evidence-source:${sourceKind}`, sourceIdentity)}` as OpaqueEvidenceSourceRef;
}

function semanticEvidence(params: {
  criterionId: string;
  predicate?: string;
  value?: GovernorJsonValue;
  payload: GovernorJsonValue;
}): { predicate: string; value: GovernorJsonValue; semanticDigest: string } {
  const predicate = (params.predicate ?? `criterion:${params.criterionId}`).trim();
  if (!predicate) {
    throw new Error("Governor evidence predicate must not be empty");
  }
  const value = params.value ?? params.payload;
  return { predicate, value, semanticDigest: governorDigest({ predicate, value }) };
}

function evidenceAdmissionKey(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY?.trim();
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "test") {
    return "governor-test-evidence-admission-key";
  }
  throw new Error("OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY is required for enabled evidence");
}

function admissionPayload(evidence: Omit<GovernorEvidenceRecord, "admissionSignature">) {
  return {
    evidenceId: evidence.evidenceId,
    taskId: evidence.taskId,
    criterionId: evidence.criterionId,
    sourceKind: evidence.sourceKind,
    sourceIdentity: evidence.sourceIdentity,
    taskVersion: evidence.taskVersion,
    objectiveRevision: evidence.objectiveRevision,
    planVersion: evidence.planVersion,
    scopeKey: evidence.scopeKey,
    observedAt: evidence.observedAt,
    evidenceDigest: evidence.evidenceDigest,
    semanticDigest: evidence.semanticDigest,
    admissibility: evidence.admissibility,
    createdAt: evidence.createdAt,
    invalidatedAt: evidence.invalidatedAt ?? null,
    admissionKeyId: evidence.admissionKeyId,
    admissionVersion: evidence.admissionVersion,
  };
}

/** Host-held authority which is the sole signer and verifier for persisted evidence. */
export class GovernorEvidenceAdmissionAuthority {
  readonly #key: string;
  readonly #keyId: string;

  private constructor(key: string, keyId: string) {
    this.#key = key;
    this.#keyId = keyId;
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GovernorEvidenceAdmissionAuthority {
    return new GovernorEvidenceAdmissionAuthority(
      evidenceAdmissionKey(env),
      env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID?.trim() || "v1",
    );
  }

  #sign(evidence: Omit<GovernorEvidenceRecord, "admissionSignature">): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson(admissionPayload(evidence)))
      .digest("hex");
  }

  admit(params: {
    task: GovernorTaskProjection;
    candidate: GovernorEvidenceCandidate;
    now: number;
  }): GovernorEvidenceAdmission {
    const base = validateEvidenceCandidate(params);
    if ("reason" in base) {
      return base;
    }
    const evidence: Omit<GovernorEvidenceRecord, "admissionSignature"> = {
      ...structuredClone(params.candidate),
      sourceIdentity: opaqueEvidenceSourceRef(
        params.candidate.sourceKind,
        params.candidate.sourceIdentity,
      ),
      ...semanticEvidence(params.candidate),
      admissibility: "admitted",
      createdAt: params.now,
      admissionKeyId: this.#keyId,
      admissionVersion: 1,
    };
    return { admitted: true, evidence: { ...evidence, admissionSignature: this.#sign(evidence) } };
  }

  assertVerified(evidence: GovernorEvidenceRecord): void {
    assertOpaqueEvidenceSourceRef(evidence.sourceIdentity);
    // The signature covers the canonical envelope, but keep the content
    // digests independently checked as well.  This makes a raw SQLite edit
    // fail closed even when a legacy/incorrect codec accidentally presents a
    // syntactically valid envelope to this verifier.
    if (governorDigest(evidence.payload) !== evidence.evidenceDigest) {
      throw new Error("Governor evidence payload digest mismatch");
    }
    if (
      governorDigest({ predicate: evidence.predicate, value: evidence.value }) !==
      evidence.semanticDigest
    ) {
      throw new Error("Governor evidence semantic digest mismatch");
    }
    if (evidence.admissionVersion !== 1 || evidence.admissionKeyId !== this.#keyId) {
      throw new Error("Governor evidence admission key/version is not accepted");
    }
    const { admissionSignature, ...unsigned } = evidence;
    const expected = this.#sign(unsigned);
    if (
      admissionSignature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(admissionSignature), Buffer.from(expected))
    ) {
      throw new Error("Governor evidence admission signature is invalid");
    }
  }
}

export type GovernorEvidenceAdmission =
  | { admitted: true; evidence: GovernorEvidenceRecord }
  | {
      admitted: false;
      reason:
        | "assistant_source"
        | "scope_mismatch"
        | "objective_revision_mismatch"
        | "future_task_version"
        | "unknown_criterion"
        | "digest_mismatch";
    };

export function createGovernorEvidenceCandidate(
  params: Omit<GovernorEvidenceCandidate, "evidenceDigest">,
): GovernorEvidenceCandidate {
  const safe = assertGovernorBoundarySafe(
    "model",
    params as unknown as GovernorJsonValue,
  ) as unknown as Omit<GovernorEvidenceCandidate, "evidenceDigest">;
  return {
    ...safe,
    evidenceDigest: governorDigest(safe.payload),
  };
}

export function admitGovernorEvidence(params: {
  task: GovernorTaskProjection;
  candidate: GovernorEvidenceCandidate;
  now: number;
}): GovernorEvidenceAdmission {
  return GovernorEvidenceAdmissionAuthority.fromEnvironment().admit(params);
}

function validateEvidenceCandidate(params: {
  task: GovernorTaskProjection;
  candidate: GovernorEvidenceCandidate;
}): Exclude<GovernorEvidenceAdmission, { admitted: true }> | { valid: true } {
  if (
    params.candidate.sourceKind === "assistant_text" ||
    params.candidate.sourceKind === "hidden_reasoning"
  ) {
    return { admitted: false, reason: "assistant_source" };
  }
  if (params.candidate.scopeKey !== params.task.scopeKey) {
    return { admitted: false, reason: "scope_mismatch" };
  }
  if (params.candidate.objectiveRevision !== params.task.objectiveRevision) {
    return { admitted: false, reason: "objective_revision_mismatch" };
  }
  if (params.candidate.planVersion !== params.task.planVersion) {
    return { admitted: false, reason: "objective_revision_mismatch" };
  }
  if (params.candidate.taskVersion > params.task.taskVersion) {
    return { admitted: false, reason: "future_task_version" };
  }
  if (
    !params.task.contract.completionCriteria.some(
      (criterion) => criterion.criterionId === params.candidate.criterionId,
    )
  ) {
    return { admitted: false, reason: "unknown_criterion" };
  }
  if (governorDigest(params.candidate.payload) !== params.candidate.evidenceDigest) {
    return { admitted: false, reason: "digest_mismatch" };
  }
  return { valid: true };
}
