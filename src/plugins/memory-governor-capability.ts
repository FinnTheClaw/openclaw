import { createHash, createHmac } from "node:crypto";

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
  retire?(params: {
    agentId: string;
    scope: string;
    scopeKey?: string;
    factKey: string;
    staleMemoryId: string;
    reason: "freshness_expired" | "operator_requested";
    now: number;
  }): Promise<{
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

export type MemoryGovernorCapability = Readonly<{
  createBackend(params: {
    mode: "shadow" | "enforce";
    authorityBindingKey?: string;
  }): MemoryGovernorBackend;
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
const OWNED_CAPABILITIES = new WeakSet<object>();

export function ownGovernorMemoryCapability(
  capability: MemoryGovernorCapability,
): MemoryGovernorCapability {
  const owned = Object.freeze({
    createBackend(params: Parameters<MemoryGovernorCapability["createBackend"]>[0]) {
      const backend = capability.createBackend(params);
      OWNED_BACKENDS.add(backend);
      return backend;
    },
  });
  OWNED_CAPABILITIES.add(owned);
  return owned;
}

export function isOwnedGovernorMemoryCapability(value: unknown): value is MemoryGovernorCapability {
  return Boolean(value && typeof value === "object" && OWNED_CAPABILITIES.has(value));
}

export function isOwnedGovernorMemoryBackend(value: unknown): value is MemoryGovernorBackend {
  return Boolean(value && typeof value === "object" && OWNED_BACKENDS.has(value));
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
