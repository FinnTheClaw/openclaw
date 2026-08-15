export const FUNCTIONAL_FINN_ENVELOPE_PROMPT = `
For the final assistant response, output exactly one JSON object and no surrounding markdown.
Schema: {"schemaVersion":1,"responseClass":"factual"|"non_factual_ack","answerText":string,"abstain":boolean,"claims":[{"claimId":string,"text":string,"classification":"observed"|"inferred","confidence":number,"sources":[{"evidenceId":string,"start":number,"end":number,"quote":string}]}]}.
For a factual answer, answerText must equal the claim texts in order, joined by a single newline; no preface, tail, or uncited prose is allowed. At least one observed claim is required, each with confidence >= 0.8 and exact spans from host-issued evidence below. Inferred claims are not eligible for release. If support is missing, use exactly "I don't have enough verified evidence to answer." with abstain=true and claims=[]. non_factual_ack is only for a short acknowledgement with no factual claims.
`.trim();

export function formatFunctionalFinnEvidenceContext(
  evidence: Array<{
    evidenceId: string;
    content: string;
    observedAt: number;
    freshnessUntil: number;
  }>,
): string | undefined {
  if (evidence.length === 0) {
    return undefined;
  }
  return [
    "Host-issued evidence for this run (cite exact character spans):",
    ...evidence.map(
      (item) =>
        `[${item.evidenceId}] observedAt=${item.observedAt} freshnessUntil=${item.freshnessUntil}\n${item.content}`,
    ),
  ].join("\n\n");
}
