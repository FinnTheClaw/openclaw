import { createHash } from "node:crypto";

export type FunctionalFinnMemorySourceKind =
  | "user_confirmed"
  | "tool_observation"
  | "authoritative_import"
  | "verifier_accepted";

export type FunctionalFinnMemoryRevision = {
  generation: number;
  claimDigest: string;
  evidenceId: string;
  observedAt: number;
  retiredAt?: number;
  retirementReason?: "superseded" | "forgotten" | "invalidated";
};

export type FunctionalFinnMemoryRecord = {
  schemaVersion: 1;
  agentId: string;
  factKey: string;
  generation: number;
  state: "verified_current" | "tombstone" | "quarantined";
  claim?: string;
  sourceKind: FunctionalFinnMemorySourceKind;
  evidenceId: string;
  sourceEvidenceIds: string[];
  observedAt: number;
  freshnessUntil: number;
  confidence: number;
  authority: number;
  revisionDigest: string;
  remediation: "pending" | "applied";
  history: FunctionalFinnMemoryRevision[];
};

export type FunctionalFinnAtomicStore<T> = {
  update: (key: string, mutate: (current: T | undefined) => T | undefined) => boolean;
  lookup: (key: string) => T | undefined;
  entries: () => Array<{ key: string; value: T }>;
};

export type AdmitFunctionalFinnMemory = {
  agentId: string;
  factKey: string;
  claim?: string;
  sourceKind: FunctionalFinnMemorySourceKind | "model_inference";
  evidenceId: string;
  sourceEvidenceIds?: string[];
  observedAt: number;
  freshnessUntil: number;
  confidence: number;
  authority: number;
  tombstone?: boolean;
};

const MAX_HISTORY = 16;

function keyOf(agentId: string, factKey: string): string {
  return `${encodeURIComponent(agentId.trim())}:${createHash("sha256").update(factKey.trim()).digest("hex")}`;
}

function digestRecord(
  record: Omit<FunctionalFinnMemoryRecord, "revisionDigest" | "remediation" | "history">,
): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function validateAdmission(input: AdmitFunctionalFinnMemory): void {
  if (!input.agentId.trim() || !input.factKey.trim() || !input.evidenceId.trim()) {
    throw new Error("memory identity and evidence are required");
  }
  if (input.sourceKind === "model_inference") {
    throw new Error("model inference cannot enter active memory");
  }
  if (!input.tombstone && !input.claim?.trim()) {
    throw new Error("verified memory requires a claim or tombstone");
  }
  if (
    !Number.isFinite(input.observedAt) ||
    !Number.isFinite(input.freshnessUntil) ||
    input.freshnessUntil < input.observedAt ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1 ||
    !Number.isFinite(input.authority) ||
    input.authority < 0
  ) {
    throw new Error("invalid memory provenance or freshness");
  }
}

function toRecord(
  input: AdmitFunctionalFinnMemory,
  generation: number,
  history: FunctionalFinnMemoryRevision[],
): FunctionalFinnMemoryRecord {
  const base = {
    schemaVersion: 1 as const,
    agentId: input.agentId.trim(),
    factKey: input.factKey.trim(),
    generation,
    state: input.tombstone ? ("tombstone" as const) : ("verified_current" as const),
    ...(input.tombstone ? {} : { claim: input.claim?.trim() }),
    sourceKind: input.sourceKind as FunctionalFinnMemorySourceKind,
    evidenceId: input.evidenceId.trim(),
    sourceEvidenceIds: [...new Set(input.sourceEvidenceIds ?? [])].toSorted(),
    observedAt: input.observedAt,
    freshnessUntil: input.freshnessUntil,
    confidence: input.confidence,
    authority: input.authority,
  };
  return {
    ...base,
    revisionDigest: digestRecord(base),
    remediation: "pending",
    history: history.slice(-MAX_HISTORY),
  };
}

export class FunctionalFinnMemoryLedger {
  constructor(private readonly store: FunctionalFinnAtomicStore<FunctionalFinnMemoryRecord>) {}

  admit(input: AdmitFunctionalFinnMemory): {
    disposition: "created" | "replayed" | "replaced";
    record: FunctionalFinnMemoryRecord;
  } {
    validateAdmission(input);
    const key = keyOf(input.agentId, input.factKey);
    let result:
      | { disposition: "created" | "replayed" | "replaced"; record: FunctionalFinnMemoryRecord }
      | undefined;
    const updated = this.store.update(key, (current) => {
      if (current?.evidenceId === input.evidenceId) {
        result = { disposition: "replayed", record: current };
        return current;
      }
      if (current) {
        if (input.observedAt <= current.observedAt || input.authority < current.authority) {
          throw new Error("replacement evidence is not newer and equally authoritative");
        }
      }
      const history = current
        ? [
            ...current.history,
            {
              generation: current.generation,
              claimDigest: createHash("sha256")
                .update(current.claim ?? "<tombstone>")
                .digest("hex"),
              evidenceId: current.evidenceId,
              observedAt: current.observedAt,
              retiredAt: input.observedAt,
              retirementReason: "superseded" as const,
            },
          ]
        : [];
      const record = toRecord(input, (current?.generation ?? 0) + 1, history);
      result = { disposition: current ? "replaced" : "created", record };
      return record;
    });
    if (!updated || !result) {
      throw new Error("memory admission did not commit");
    }
    return result;
  }

  recall(params: {
    agentId: string;
    now: number;
    factKey?: string;
    limit?: number;
  }): FunctionalFinnMemoryRecord[] {
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
    const values = params.factKey
      ? [this.store.lookup(keyOf(params.agentId, params.factKey))]
      : this.store.entries().map((entry) => entry.value);
    return values
      .filter((record): record is FunctionalFinnMemoryRecord => Boolean(record))
      .filter(
        (record) =>
          record.agentId === params.agentId &&
          record.state === "verified_current" &&
          record.freshnessUntil >= params.now,
      )
      .toSorted((a, b) => b.observedAt - a.observedAt || a.factKey.localeCompare(b.factKey))
      .slice(0, limit);
  }

  markRemediated(params: { agentId: string; factKey: string; revisionDigest: string }): boolean {
    return this.store.update(keyOf(params.agentId, params.factKey), (current) => {
      if (!current || current.revisionDigest !== params.revisionDigest) {
        throw new Error("stale remediation receipt");
      }
      return current.remediation === "applied" ? current : { ...current, remediation: "applied" };
    });
  }
}
