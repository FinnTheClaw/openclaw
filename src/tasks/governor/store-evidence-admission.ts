// Admits and verifies evidence using only a broker-issued read-only receipt resolver.
import crypto from "node:crypto";
import type {
  GovernorTrustedReceiptResolver,
  HostGovernorReceiptId,
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
import type { GovernorTaskProjection } from "./types.js";

declare const governorPendingEvidenceBrand: unique symbol;

/** Opaque, store-bound admission. It cannot be manufactured from data. */
export type GovernorPendingEvidence = {
  readonly evidence: GovernorEvidenceRecord;
  readonly [governorPendingEvidenceBrand]: object;
};

function admissionKey(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY?.trim();
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "test") {
    return "governor-test-evidence-admission-key";
  }
  throw new Error("OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY is required for enabled evidence");
}

export class GovernorEvidenceAdmissionStore {
  readonly #resolver: GovernorTrustedReceiptResolver;
  readonly #key: string;
  readonly #keyId: string;
  readonly #pending = new WeakSet<object>();

  constructor(params: {
    receiptResolver: GovernorTrustedReceiptResolver;
    env?: NodeJS.ProcessEnv;
  }) {
    this.#resolver = params.receiptResolver;
    const env = params.env ?? process.env;
    this.#key = admissionKey(env);
    this.#keyId = env.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID?.trim() || "v1";
  }

  #sign(evidence: Omit<GovernorEvidenceRecord, "admissionSignature">): string {
    return crypto
      .createHmac("sha256", this.#key)
      .update(canonicalGovernorJson(governorEvidenceAdmissionPayload(evidence)))
      .digest("hex");
  }

  verify(evidence: GovernorEvidenceRecord): void {
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
    const candidate = createGovernorEvidenceCandidate(params.candidate);
    const validation = validateGovernorEvidenceCandidate({ task: params.task, candidate });
    if ("admitted" in validation && validation.admitted === false) {
      throw new Error(`Governor evidence candidate rejected: ${validation.reason}`);
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
      sourceIdentity: opaqueEvidenceSourceRef(receipt.sourceKind, receipt.sourceIdentity),
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
