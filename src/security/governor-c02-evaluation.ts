export const C02_EVALUATION_SESSION_PREFIX = "c02-eval:";
export const C02_AGGREGATE_COMMAND = "/usr/bin/python3 -c 'print(3)'";

const SESSION = /^c02-eval:(c02-([a-f])-[0-9]{3}):([a-f0-9]{24})$/iu;

export type C02Evaluation = Readonly<{
  caseId: string;
  family: "A" | "B" | "C" | "D" | "E" | "F";
  requestNonce: string;
  alphaPath: string;
  betaPath: string;
  stableSourceMessageId: string;
  stableSessionId: string;
  restartAfterObserveB: boolean;
}>;

export function parseC02EvaluationSession(sessionKey: string): C02Evaluation | undefined {
  const match = SESSION.exec(sessionKey);
  if (!match) {
    return undefined;
  }
  const [, rawCaseId, rawFamily, requestNonce] = match;
  if (!rawCaseId || !rawFamily || !requestNonce) {
    return undefined;
  }
  const caseId = rawCaseId.toUpperCase();
  const family = rawFamily.toUpperCase() as C02Evaluation["family"];
  const canonicalRequestNonce = requestNonce.toLowerCase();
  const stableIdentity = `${caseId}:${canonicalRequestNonce}`;
  return Object.freeze({
    caseId,
    family,
    requestNonce: canonicalRequestNonce,
    alphaPath: `/case/${caseId}/alpha.txt`,
    betaPath: `/case/${caseId}/beta.txt`,
    stableSourceMessageId: `c02-eval-source:${stableIdentity}`,
    stableSessionId: `c02-eval-session:${stableIdentity}`,
    restartAfterObserveB: family === "F",
  });
}
