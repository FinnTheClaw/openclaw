export const C02_EVALUATION_SESSION_PREFIX = "c02-eval:";
export const C02_AGGREGATE_COMMAND = "/usr/bin/python3 -c 'print(3)'";

const SESSION = /^c02-eval:(C02-([A-F])-[0-9]{3}):([a-f0-9]{24})$/u;

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
  const [, caseId, family, requestNonce] = match;
  if (!caseId || !family || !requestNonce) {
    return undefined;
  }
  const stableIdentity = `${caseId}:${requestNonce}`;
  return Object.freeze({
    caseId,
    family: family as C02Evaluation["family"],
    requestNonce,
    alphaPath: `/case/${caseId}/alpha.txt`,
    betaPath: `/case/${caseId}/beta.txt`,
    stableSourceMessageId: `c02-eval-source:${stableIdentity}`,
    stableSessionId: `c02-eval-session:${stableIdentity}`,
    restartAfterObserveB: family === "F",
  });
}
