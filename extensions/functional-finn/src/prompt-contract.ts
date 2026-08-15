export const FUNCTIONAL_FINN_ENVELOPE_PROMPT = `
For the final assistant response, output exactly one JSON object and no surrounding markdown.
Schema: {"schemaVersion":1,"responseClass":"factual"|"non_factual_ack","answerText":string,"abstain":boolean,"claims":[{"claimId":string,"text":string,"classification":"observed"|"inferred","confidence":number,"sources":[{"evidenceId":string,"start":number,"end":number,"quote":string}]}]}.
Every factual claim must be atomic and cite exact spans from host-issued evidence below. Inference alone is not evidence. If support is missing, omit the claim or abstain. non_factual_ack is only for a short acknowledgement with no factual claims.
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
