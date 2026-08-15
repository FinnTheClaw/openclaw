import type { FunctionalFinnEvidenceStore } from "./evidence-store.js";
import type { FunctionalFinnMemoryLedger, FunctionalFinnMemoryRecord } from "./memory-ledger.js";

export type FunctionalFinnMemoryAdmission = {
  factKey: string;
  claim: string;
  sourceEvidenceId: string;
  sourceStart: number;
  sourceEnd: number;
  sourceQuote: string;
  tombstone?: boolean;
};

const AUTHORITY = {
  user_confirmed: 100,
  authoritative_import: 90,
  tool_observation: 80,
} as const;

export async function admitFunctionalFinnMemory(params: {
  input: FunctionalFinnMemoryAdmission;
  agentId: string;
  now: number;
  evidence: FunctionalFinnEvidenceStore;
  ledger: FunctionalFinnMemoryLedger;
  verifySupport: (params: {
    claim: string;
    evidence: NonNullable<ReturnType<FunctionalFinnEvidenceStore["lookup"]>>;
    sourceStart: number;
    sourceEnd: number;
    sourceQuote: string;
  }) => Promise<boolean>;
  reconcile: () => Promise<unknown>;
}): Promise<FunctionalFinnMemoryRecord> {
  const source = params.evidence.lookup(params.input.sourceEvidenceId);
  if (!source || source.state !== "current") {
    throw new Error("memory source evidence is unavailable");
  }
  if (source.agentId !== params.agentId) {
    throw new Error("memory source evidence belongs to another agent");
  }
  if (source.observedAt > params.now || source.freshnessUntil < params.now) {
    throw new Error("memory source evidence is stale");
  }
  if (
    !Number.isSafeInteger(params.input.sourceStart) ||
    !Number.isSafeInteger(params.input.sourceEnd) ||
    params.input.sourceStart < 0 ||
    params.input.sourceEnd <= params.input.sourceStart ||
    source.content.slice(params.input.sourceStart, params.input.sourceEnd) !==
      params.input.sourceQuote
  ) {
    throw new Error("memory source span does not match host evidence");
  }
  if (
    !(await params.verifySupport({
      claim: params.input.claim,
      evidence: source,
      sourceStart: params.input.sourceStart,
      sourceEnd: params.input.sourceEnd,
      sourceQuote: params.input.sourceQuote,
    }))
  ) {
    throw new Error("memory claim is not supported by source evidence");
  }
  const result = params.ledger.admit({
    agentId: params.agentId,
    factKey: params.input.factKey,
    claim: params.input.claim,
    sourceKind: source.sourceKind,
    evidenceId: source.evidenceId,
    sourceEvidenceIds: [source.evidenceId],
    observedAt: source.observedAt,
    freshnessUntil: source.freshnessUntil,
    confidence: 1,
    authority: AUTHORITY[source.sourceKind],
    tombstone: params.input.tombstone,
  });
  await params.reconcile();
  const reconciled = params.ledger.lookup(params.agentId, params.input.factKey);
  if (
    !reconciled ||
    reconciled.revisionDigest !== result.record.revisionDigest ||
    reconciled.remediation.state !== "applied"
  ) {
    throw new Error("memory projection did not acknowledge the admitted revision");
  }
  return reconciled;
}
