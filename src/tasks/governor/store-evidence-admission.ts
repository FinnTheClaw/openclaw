// Admits and verifies evidence using only a broker-issued read-only receipt resolver.
import crypto from "node:crypto";
import {
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedReceiptResolver,
  type HostGovernorReceiptId,
} from "../../security/governor-host-readonly.js";
import { canonicalGovernorJson, governorDigest } from "./canonical-json.js";
import {
  assertOpaqueEvidenceSourceRef,
  createGovernorEvidenceCandidate,
  deriveGovernorEvidenceSemantics,
  governorEvidenceAdmissionPayload,
  opaqueEvidenceSourceRef,
  validateGovernorEvidenceCandidate,
  type GovernorEvidenceCandidate,
  type GovernorEvidenceRecord,
} from "./evidence.js";
import { assertGovernorPersistedJson } from "./persistence-guard.js";
import type { GovernorIdentityContext, GovernorTaskProjection } from "./types.js";

declare const governorPendingEvidenceBrand: unique symbol;
const ADMISSION_STORES = new WeakSet<object>();

/** Opaque, store-bound admission. It cannot be manufactured from data. */
export type GovernorPendingEvidence = {
  readonly evidence: GovernorEvidenceRecord;
  readonly [governorPendingEvidenceBrand]: object;
};

export class GovernorEvidenceAdmissionStore {
  readonly #resolver: GovernorTrustedReceiptResolver;
  readonly #identity: GovernorIdentityContext;
  readonly #key: string;
  readonly #keyId: string;
  readonly #pending = new WeakSet<object>();

  constructor(params: {
    receiptResolver: GovernorTrustedReceiptResolver;
    identity: GovernorIdentityContext;
    evidenceAdmissionKey: string;
    evidenceAdmissionKeyId: string;
  }) {
    if (!isTrustedGovernorReceiptResolver(params.receiptResolver)) {
      throw new Error("Governor evidence admission requires a trusted host receipt resolver");
    }
    this.#resolver = params.receiptResolver;
    this.#identity = params.identity;
    this.#key = params.evidenceAdmissionKey.trim();
    this.#keyId = params.evidenceAdmissionKeyId.trim();
    if (!this.#key || !this.#keyId) {
      throw new Error("Governor evidence admission key and key ID are required");
    }
    ADMISSION_STORES.add(this);
  }

  #sign(evidence: Omit<GovernorEvidenceRecord, "admissionSignature">): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson(governorEvidenceAdmissionPayload(evidence)))
      .digest("hex");
  }

  verify(evidence: GovernorEvidenceRecord): void {
    assertGovernorPersistedJson("log", evidence);
    assertOpaqueEvidenceSourceRef(evidence.sourceIdentity);
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

  admit(params: {
    task: GovernorTaskProjection;
    candidate: GovernorEvidenceCandidate;
    receiptId?: string;
    now: number;
  }): GovernorPendingEvidence {
    assertGovernorPersistedJson("log", params.candidate);
    const candidate = createGovernorEvidenceCandidate(params.candidate);
    const validation = validateGovernorEvidenceCandidate({ task: params.task, candidate });
    if ("admitted" in validation && !validation.admitted) {
      throw new Error("GOVERNOR_EVIDENCE_CANDIDATE_REJECTED");
    }
    if (!params.receiptId) {
      throw new Error("Governor evidence requires a trusted host receipt");
    }
    const receipt = this.#resolver.resolve(
      params.receiptId as HostGovernorReceiptId,
      params.task.scopeKey,
    );
    if (!receipt) {
      throw new Error("Governor evidence receipt is unknown, invalid, or out of scope");
    }
    if (
      receipt.sourceKind !== candidate.sourceKind ||
      receipt.sourceIdentity !== candidate.sourceIdentity ||
      receipt.taskId !== candidate.taskId ||
      receipt.taskVersion !== candidate.taskVersion ||
      receipt.objectiveRevision !== candidate.objectiveRevision ||
      receipt.planVersion !== candidate.planVersion ||
      receipt.observedAt !== candidate.observedAt ||
      governorDigest(receipt.payload) !== candidate.evidenceDigest ||
      governorDigest(receipt.payload) !== governorDigest(candidate.payload)
    ) {
      throw new Error("Governor evidence candidate does not match its trusted receipt");
    }
    const semantic = deriveGovernorEvidenceSemantics({
      criterionId: candidate.criterionId,
      predicate: candidate.predicate,
      value: candidate.value,
      payload: receipt.payload,
    });
    const unsigned: Omit<GovernorEvidenceRecord, "admissionSignature"> = {
      ...candidate,
      payload: receipt.payload,
      evidenceDigest: governorDigest(receipt.payload),
      sourceIdentity: opaqueEvidenceSourceRef(
        receipt.sourceKind,
        receipt.sourceIdentity,
        this.#identity,
      ),
      ...semantic,
      admissibility: "admitted",
      createdAt: params.now,
      admissionKeyId: this.#keyId,
      admissionVersion: 1,
    };
    const evidence = Object.freeze({ ...unsigned, admissionSignature: this.#sign(unsigned) });
    const pending = Object.freeze({ evidence }) as GovernorPendingEvidence;
    this.#pending.add(pending);
    return pending;
  }

  owns(pending: GovernorPendingEvidence): boolean {
    return this.#pending.has(pending);
  }
}

export function isGovernorEvidenceAdmissionStore(value: GovernorEvidenceAdmissionStore): boolean {
  return ADMISSION_STORES.has(value);
}
