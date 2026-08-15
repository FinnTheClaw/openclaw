export type FunctionalFinnEvidence = {
  evidenceId: string;
  agentId: string;
  content: string;
  observedAt: number;
  freshnessUntil: number;
  sourceKind: "user_confirmed" | "tool_observation" | "authoritative_import";
  state: "current" | "superseded" | "quarantined";
};

export type FunctionalFinnClaim = {
  claimId: string;
  text: string;
  classification: "observed" | "inferred";
  confidence: number;
  sources: Array<{ evidenceId: string; start: number; end: number; quote: string }>;
};

export type FunctionalFinnAnswerEnvelope = {
  schemaVersion: 1;
  responseClass: "non_factual_ack" | "factual";
  answerText: string;
  abstain: boolean;
  claims: FunctionalFinnClaim[];
};

export type FunctionalFinnEnvelopeFailure = {
  code:
    | "INVALID_ENVELOPE"
    | "INVALID_ACKNOWLEDGEMENT"
    | "UNSUPPORTED_CLAIM"
    | "STALE_EVIDENCE"
    | "WRONG_SCOPE"
    | "SEMANTIC_SUPPORT_FAILED"
    | "NON_CANONICAL_ANSWER"
    | "INVALID_ABSTENTION"
    | "INELIGIBLE_CLAIM";
  claimId?: string;
};

const ACKNOWLEDGEMENT =
  /^(?:ok(?:ay)?|thanks|thank you|got it|understood|noted|sounds good|you're welcome)[!. ]*$/iu;

export const FUNCTIONAL_FINN_ABSTENTION_TEXT = "I don't have enough verified evidence to answer.";

/** The only releasable factual prose is this mechanical rendering of atomic claims. */
export function renderFunctionalFinnAnswer(envelope: FunctionalFinnAnswerEnvelope): string {
  if (envelope.responseClass === "non_factual_ack") {
    return envelope.answerText.trim();
  }
  if (envelope.abstain) {
    return FUNCTIONAL_FINN_ABSTENTION_TEXT;
  }
  return envelope.claims.map((claim) => claim.text).join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSource(value: unknown): FunctionalFinnClaim["sources"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const { evidenceId, start, end, quote } = value;
  if (
    typeof evidenceId !== "string" ||
    !evidenceId.trim() ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    typeof quote !== "string" ||
    !quote
  ) {
    return undefined;
  }
  return { evidenceId, start: start as number, end: end as number, quote };
}

function parseClaim(value: unknown): FunctionalFinnClaim | undefined {
  if (!isObject(value) || !Array.isArray(value.sources)) {
    return undefined;
  }
  const sources = value.sources.map(parseSource);
  if (
    typeof value.claimId !== "string" ||
    !value.claimId.trim() ||
    value.claimId !== value.claimId.trim() ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text !== value.text.trim() ||
    (value.classification !== "observed" && value.classification !== "inferred") ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    sources.length === 0 ||
    sources.length > 6 ||
    sources.some((source) => !source)
  ) {
    return undefined;
  }
  return {
    claimId: value.claimId,
    text: value.text,
    classification: value.classification,
    confidence: value.confidence,
    sources: sources as FunctionalFinnClaim["sources"],
  };
}

export function parseFunctionalFinnAnswerEnvelope(
  value: unknown,
): FunctionalFinnAnswerEnvelope | undefined {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isObject(raw) || !Array.isArray(raw.claims)) {
    return undefined;
  }
  const claims = raw.claims.map(parseClaim);
  if (
    raw.schemaVersion !== 1 ||
    (raw.responseClass !== "non_factual_ack" && raw.responseClass !== "factual") ||
    typeof raw.answerText !== "string" ||
    !raw.answerText.trim() ||
    raw.answerText.length > 3_500 ||
    typeof raw.abstain !== "boolean" ||
    claims.length > 20 ||
    claims.some((claim) => !claim)
  ) {
    return undefined;
  }
  const envelope: FunctionalFinnAnswerEnvelope = {
    schemaVersion: 1,
    responseClass: raw.responseClass,
    answerText: raw.answerText,
    abstain: raw.abstain,
    claims: claims as FunctionalFinnClaim[],
  };
  if (envelope.responseClass === "non_factual_ack") {
    return !envelope.abstain &&
      envelope.claims.length === 0 &&
      envelope.answerText === envelope.answerText.trim() &&
      ACKNOWLEDGEMENT.test(envelope.answerText)
      ? envelope
      : undefined;
  }
  if (envelope.abstain) {
    return envelope.claims.length === 0 && envelope.answerText === FUNCTIONAL_FINN_ABSTENTION_TEXT
      ? envelope
      : undefined;
  }
  return envelope.claims.length > 0 &&
    new Set(envelope.claims.map((claim) => claim.claimId)).size === envelope.claims.length &&
    envelope.answerText === renderFunctionalFinnAnswer(envelope) &&
    envelope.claims.every((claim) => claim.classification === "observed" && claim.confidence >= 0.8)
    ? envelope
    : undefined;
}

export async function validateFunctionalFinnAnswer(params: {
  envelope: FunctionalFinnAnswerEnvelope;
  agentId: string;
  now: number;
  lookupEvidence: (evidenceId: string) => FunctionalFinnEvidence | undefined;
  supportScore: (claim: string, support: string) => Promise<number>;
}): Promise<{ ok: true } | { ok: false; failure: FunctionalFinnEnvelopeFailure }> {
  const { envelope } = params;
  if (envelope.responseClass === "non_factual_ack") {
    return !envelope.abstain &&
      envelope.claims.length === 0 &&
      envelope.answerText === envelope.answerText.trim() &&
      ACKNOWLEDGEMENT.test(envelope.answerText)
      ? { ok: true }
      : { ok: false, failure: { code: "INVALID_ACKNOWLEDGEMENT" } };
  }
  if (envelope.abstain) {
    return envelope.claims.length === 0 && envelope.answerText === FUNCTIONAL_FINN_ABSTENTION_TEXT
      ? { ok: true }
      : { ok: false, failure: { code: "INVALID_ABSTENTION" } };
  }
  if (envelope.claims.length === 0) {
    return { ok: false, failure: { code: "INVALID_ENVELOPE" } };
  }
  if (envelope.answerText !== renderFunctionalFinnAnswer(envelope)) {
    return { ok: false, failure: { code: "NON_CANONICAL_ANSWER" } };
  }
  const claimIds = new Set<string>();
  for (const claim of envelope.claims) {
    if (
      claimIds.has(claim.claimId) ||
      claim.classification !== "observed" ||
      claim.confidence < 0.8
    ) {
      return { ok: false, failure: { code: "INELIGIBLE_CLAIM", claimId: claim.claimId } };
    }
    claimIds.add(claim.claimId);
  }
  for (const claim of envelope.claims) {
    const support: string[] = [];
    for (const source of claim.sources) {
      const evidence = params.lookupEvidence(source.evidenceId);
      if (!evidence || evidence.state !== "current") {
        return { ok: false, failure: { code: "UNSUPPORTED_CLAIM", claimId: claim.claimId } };
      }
      if (evidence.agentId !== params.agentId) {
        return { ok: false, failure: { code: "WRONG_SCOPE", claimId: claim.claimId } };
      }
      if (evidence.observedAt > params.now || evidence.freshnessUntil < params.now) {
        return { ok: false, failure: { code: "STALE_EVIDENCE", claimId: claim.claimId } };
      }
      if (evidence.content.slice(source.start, source.end) !== source.quote) {
        return { ok: false, failure: { code: "UNSUPPORTED_CLAIM", claimId: claim.claimId } };
      }
      support.push(source.quote);
    }
    const score = await params.supportScore(claim.text, support.join("\n"));
    if (!Number.isFinite(score) || score < 0.8) {
      return { ok: false, failure: { code: "SEMANTIC_SUPPORT_FAILED", claimId: claim.claimId } };
    }
  }
  return { ok: true };
}
