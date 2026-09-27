import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type MemoryGovernorSourceKind =
  | "structured_external"
  | "authenticated_user"
  | "tool"
  | "historical_memory";

export type MemoryGovernorFact = Readonly<{
  memoryId: string;
  agentId: string;
  scope: string;
  scopeKey: string;
  scopeEpoch: number;
  factKey: string;
  subject: string;
  predicate: string;
  object: string;
  text: string;
  content: unknown;
  contentDigest: string;
  category?: string;
  status: "verified" | "tombstone";
  sensitivity: "normal" | "sensitive";
  sourceKind: MemoryGovernorSourceKind;
  sourceIdentity: string;
  sourceRank: number;
  confidence: number;
  authority: number;
  authorityRank: number;
  generation: number;
  observedAt: number;
  freshnessExpiresAt?: number;
  provenance: Readonly<{
    sourceRef: string;
    observedAt: number;
    recordedAt: number;
    scopeKey: string;
    confidence: number;
    sensitivity: "normal" | "sensitive";
    evidenceTaskId?: string;
    evidenceTaskVersion?: number;
    objectiveRevision?: number;
    planVersion?: number;
  }>;
  authorityBindingDigest: string;
  authorityBindingMac?: string;
  sourceEvidenceId: string;
  sourceEvidenceDigest: string;
  sourceEvidenceSemanticDigest: string;
  sourceEvidenceLineage?: readonly string[];
  sourceMemoryLineage?: readonly string[];
}>;

export type MemoryGovernorRecall = Readonly<{
  memoryId: string;
  agentId: string;
  scope: string;
  scopeKey: string;
  factKey: string;
  text: string;
  confidence: number;
  authority: number;
  observedAt: number;
  sourceEvidenceDigest: string;
  contentDigest: string;
  authorityBindingDigest: string;
}>;

export type MemoryGovernorRetirementReason = "expiry" | "explicit_forget";

export type MemoryGovernorRetirementDecision = Readonly<{
  schemaVersion: 1;
  authorityId: "openclaw-governor-memory";
  authorityKeyId: string;
  authorityKeyVersion: 1;
  scopeKey: string;
  factKey: string;
  staleMemoryId: string;
  priorGeneration: number;
  newGeneration: number;
  semanticCutoff: number;
  issuedAt: number;
  reason: MemoryGovernorRetirementReason;
  priorAuthorityBindingDigest: string;
  retirementBindingDigest: string;
  decisionId: string;
  signature: string;
}>;

export type MemoryGovernorBackend = Readonly<{
  admit(params: {
    fact: MemoryGovernorFact;
    now: number;
  }): Promise<
    | { status: "admitted"; fact: MemoryGovernorFact; remediationId: string }
    | { status: "duplicate"; fact: MemoryGovernorFact; remediationId: string }
    | { status: "rejected"; reason: string }
  >;
  recall(params: {
    agentId: string;
    scopes: readonly string[];
    scopeKeys?: readonly string[];
    query: string;
    limit: number;
    now: number;
  }): Promise<readonly MemoryGovernorRecall[]>;
  invalidate(params: {
    agentId: string;
    scope: string;
    scopeKey?: string;
    factKey: string;
    staleMemoryId: string;
    sourceEvidenceId: string;
    sourceEvidenceDigest: string;
    sourceObservedAt: number;
    reason: "contradicted_by_newer_evidence" | "freshness_expired" | "operator_requested";
    replacement?: MemoryGovernorFact;
    now: number;
  }): Promise<{
    status: "retired" | "duplicate" | "tombstoned";
    staleMemoryId: string;
    replacementMemoryId?: string;
    remediationId: string;
  }>;
  retire?(decision: MemoryGovernorRetirementDecision): Promise<{
    status: "retired" | "duplicate";
    staleMemoryId: string;
    remediationId: string;
  }>;
  compact(params: { agentId?: string; now: number; retentionMs: number }): Promise<{
    compacted: number;
    retainedHighWater: number;
  }>;
  close?(): Promise<void> | void;
}>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function governorMemoryContentDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function governorMemoryAuthorityKeyId(key: string): string {
  return governorMemoryContentDigest({ purpose: "governor-memory-authority-key", key });
}

function secureEqual(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function assertRetirementInput(input: {
  scopeKey: string;
  factKey: string;
  staleMemoryId: string;
  priorGeneration: number;
  newGeneration: number;
  semanticCutoff: number;
  issuedAt: number;
  reason: MemoryGovernorRetirementReason;
  priorAuthorityBindingDigest: string;
}): void {
  if (
    !input.scopeKey ||
    !input.factKey ||
    !input.staleMemoryId ||
    !Number.isSafeInteger(input.priorGeneration) ||
    input.priorGeneration < 0 ||
    input.newGeneration !== input.priorGeneration + 1 ||
    !Number.isSafeInteger(input.semanticCutoff) ||
    input.semanticCutoff < 0 ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < input.semanticCutoff ||
    (input.reason !== "expiry" && input.reason !== "explicit_forget") ||
    !/^[a-f0-9]{64}$/u.test(input.priorAuthorityBindingDigest)
  ) {
    throw new Error("GOVERNOR_MEMORY_RETIREMENT_DECISION_INVALID");
  }
}

export function createGovernorMemoryRetirementDecision(
  input: {
    scopeKey: string;
    factKey: string;
    staleMemoryId: string;
    priorGeneration: number;
    newGeneration: number;
    semanticCutoff: number;
    issuedAt: number;
    reason: MemoryGovernorRetirementReason;
    priorAuthorityBindingDigest: string;
  },
  key: string,
): MemoryGovernorRetirementDecision {
  if (!key) {
    throw new Error("GOVERNOR_MEMORY_AUTHORITY_KEY_REQUIRED");
  }
  assertRetirementInput(input);
  const authority = {
    schemaVersion: 1 as const,
    authorityId: "openclaw-governor-memory" as const,
    authorityKeyId: governorMemoryAuthorityKeyId(key),
    authorityKeyVersion: 1 as const,
    ...input,
  };
  const retirementBindingDigest = governorMemoryContentDigest({
    kind: "memory-retired",
    ...authority,
  });
  const unsigned = { ...authority, retirementBindingDigest };
  const decisionId = governorMemoryContentDigest({
    kind: "memory-retirement-decision",
    ...unsigned,
  });
  const signature = createHmac("sha256", key)
    .update(JSON.stringify(canonical({ ...unsigned, decisionId })))
    .digest("hex");
  return Object.freeze({ ...unsigned, decisionId, signature });
}

export function verifyGovernorMemoryRetirementDecision(
  decision: MemoryGovernorRetirementDecision,
  key: string,
): boolean {
  try {
    assertRetirementInput(decision);
    const expected = createGovernorMemoryRetirementDecision(
      {
        scopeKey: decision.scopeKey,
        factKey: decision.factKey,
        staleMemoryId: decision.staleMemoryId,
        priorGeneration: decision.priorGeneration,
        newGeneration: decision.newGeneration,
        semanticCutoff: decision.semanticCutoff,
        issuedAt: decision.issuedAt,
        reason: decision.reason,
        priorAuthorityBindingDigest: decision.priorAuthorityBindingDigest,
      },
      key,
    );
    return (
      decision.schemaVersion === expected.schemaVersion &&
      decision.authorityId === expected.authorityId &&
      decision.authorityKeyId === expected.authorityKeyId &&
      decision.authorityKeyVersion === expected.authorityKeyVersion &&
      decision.retirementBindingDigest === expected.retirementBindingDigest &&
      decision.decisionId === expected.decisionId &&
      secureEqual(decision.signature, expected.signature)
    );
  } catch {
    return false;
  }
}

export function governorMemoryFactMac(fact: MemoryGovernorFact, key: string): string {
  if (!key) {
    throw new Error("GOVERNOR_MEMORY_AUTHORITY_KEY_REQUIRED");
  }
  const { authorityBindingMac: _ignored, ...unsigned } = {
    ...fact,
    sourceEvidenceLineage: fact.sourceEvidenceLineage ?? [],
    sourceMemoryLineage: fact.sourceMemoryLineage ?? [],
  };
  return createHmac("sha256", key)
    .update(JSON.stringify(canonical(unsigned)))
    .digest("hex");
}

/** The immutable binding shared by the host ledger and the LanceDB projection. */
export function governorMemoryAuthorityBindingDigest(fact: MemoryGovernorFact): string {
  const digest = (value: unknown): string =>
    createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex");
  return digest({
    kind: "memory-current",
    scopeKey: fact.scopeKey,
    factKey: fact.factKey,
    scopeEpoch: fact.scopeEpoch,
    memoryId: fact.memoryId,
    sourceKind: fact.sourceKind,
    sourceIdentity: fact.sourceIdentity,
    sourceReference: fact.provenance.sourceRef,
    freshnessExpiresAt: fact.freshnessExpiresAt ?? null,
    sensitivity: fact.sensitivity,
    authority: fact.authority,
    authorityRank: fact.authorityRank,
    generation: fact.generation,
    sourceEvidenceId: fact.sourceEvidenceId,
    sourceEvidenceLineage: fact.sourceEvidenceLineage ?? [],
    sourceMemoryLineage: fact.sourceMemoryLineage ?? [],
    factDigest: digest({
      scopeKey: fact.scopeKey,
      scopeEpoch: fact.scopeEpoch,
      factKey: fact.factKey,
    }),
    contentDigest: fact.contentDigest,
    provenanceDigest: digest(fact.provenance),
    evidenceDigest: fact.sourceEvidenceDigest,
    semanticDigest: fact.sourceEvidenceSemanticDigest,
    ordering: {
      scopeEpoch: fact.scopeEpoch,
      observedAt: fact.observedAt,
      recordedAt: fact.provenance.recordedAt,
      sourceRank: fact.sourceRank,
      confidenceMillionths: Math.round(fact.confidence * 1_000_000),
      taskVersion: fact.provenance.evidenceTaskVersion,
      objectiveRevision: fact.provenance.objectiveRevision,
      planVersion: fact.provenance.planVersion,
      taskDigest: digest({ taskId: fact.provenance.evidenceTaskId }),
    },
  });
}

export function authenticateGovernorMemoryFact(
  fact: MemoryGovernorFact,
  key: string,
): MemoryGovernorFact {
  const normalized = {
    ...fact,
    sourceEvidenceLineage: fact.sourceEvidenceLineage ?? [],
    sourceMemoryLineage: fact.sourceMemoryLineage ?? [],
  };
  return { ...normalized, authorityBindingMac: governorMemoryFactMac(normalized, key) };
}

export function verifyGovernorMemoryFact(fact: MemoryGovernorFact, key: string): boolean {
  return (
    fact.authorityBindingDigest === governorMemoryAuthorityBindingDigest(fact) &&
    fact.authorityBindingMac === governorMemoryFactMac(fact, key)
  );
}

const OWNED_BACKENDS = new WeakSet<object>();
export function isOwnedGovernorMemoryBackend(value: unknown): value is MemoryGovernorBackend {
  return Boolean(value && typeof value === "object" && OWNED_BACKENDS.has(value));
}

/** Host-only registration code brands backends after verified bundled construction. */
export function ownGovernorMemoryBackend(backend: MemoryGovernorBackend): MemoryGovernorBackend {
  OWNED_BACKENDS.add(backend);
  return backend;
}

/** Shadow keeps the memory contract present while making every mutation inert. */
export function createInertMemoryGovernorBackend(): MemoryGovernorBackend {
  return Object.freeze({
    admit: async () => ({ status: "rejected" as const, reason: "shadow_observation_only" }),
    recall: async () => [],
    invalidate: async () => {
      throw new Error("GOVERNOR_MEMORY_SHADOW_MUTATION");
    },
    compact: async () => ({ compacted: 0, retainedHighWater: 0 }),
    close: () => undefined,
  });
}
