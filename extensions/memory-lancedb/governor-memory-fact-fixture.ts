import { createHash } from "node:crypto";
import {
  governorMemoryAuthorityBindingDigest,
  governorMemoryContentDigest,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryGovernorFact } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

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

export function governorMemoryFixtureDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function authorityBindingDigest(fact: MemoryGovernorFact): string {
  return governorMemoryAuthorityBindingDigest(fact);
}

export function governorMemoryFact(
  overrides: Partial<MemoryGovernorFact> & { memoryId?: string } = {},
): MemoryGovernorFact {
  const sourceKind = overrides.sourceKind ?? "structured_external";
  const sourceRank =
    sourceKind === "structured_external"
      ? 600
      : sourceKind === "authenticated_user"
        ? 500
        : sourceKind === "tool"
          ? 400
          : 200;
  const scopeKey = overrides.scopeKey ?? overrides.scope ?? "scope-a";
  const memoryId = overrides.memoryId ?? "memory-a";
  const sourceEvidenceId =
    overrides.sourceEvidenceId ?? (memoryId === "memory-a" ? "evidence-a" : `evidence-${memoryId}`);
  const sourceEvidenceDigest =
    overrides.sourceEvidenceDigest ?? (memoryId === "memory-a" ? "digest-a" : `digest-${memoryId}`);
  const sourceEvidenceSemanticDigest =
    overrides.sourceEvidenceSemanticDigest ?? `semantic-${sourceEvidenceDigest}`;
  const observedAt = overrides.observedAt ?? 100;
  const content = overrides.content ?? { object: overrides.object ?? "standard" };
  const sourceIdentity =
    overrides.sourceIdentity ?? (memoryId === "memory-a" ? "host-evidence-a" : `host-${memoryId}`);
  const confidence = overrides.confidence ?? 0.95;
  const provenance = {
    sourceRef: sourceIdentity,
    observedAt,
    recordedAt: overrides.provenance?.recordedAt ?? observedAt,
    scopeKey,
    confidence,
    sensitivity: overrides.sensitivity ?? overrides.provenance?.sensitivity ?? "normal",
    ...overrides.provenance,
  } as MemoryGovernorFact["provenance"];
  const fact: MemoryGovernorFact = {
    memoryId,
    agentId: overrides.agentId ?? "agent-a",
    scope: overrides.scope ?? scopeKey,
    scopeKey,
    scopeEpoch: overrides.scopeEpoch ?? 0,
    factKey: overrides.factKey ?? "account.plan",
    subject: overrides.subject ?? "account",
    predicate: overrides.predicate ?? "plan",
    object: overrides.object ?? "standard",
    text: overrides.text ?? "The account uses the standard plan.",
    category: overrides.category ?? "fact",
    content,
    contentDigest: governorMemoryContentDigest(content),
    status: "verified",
    sensitivity: overrides.sensitivity ?? "normal",
    sourceKind,
    sourceIdentity,
    sourceRank,
    confidence,
    authority: overrides.authority ?? sourceRank / 1000,
    authorityRank: sourceRank,
    generation: overrides.generation ?? 1,
    observedAt,
    ...(overrides.freshnessExpiresAt === undefined
      ? {}
      : { freshnessExpiresAt: overrides.freshnessExpiresAt }),
    provenance,
    authorityBindingDigest: "",
    sourceEvidenceId,
    sourceEvidenceDigest,
    sourceEvidenceSemanticDigest,
    ...(overrides.sourceEvidenceLineage
      ? { sourceEvidenceLineage: overrides.sourceEvidenceLineage }
      : {}),
    ...(overrides.sourceMemoryLineage
      ? { sourceMemoryLineage: overrides.sourceMemoryLineage }
      : {}),
  };
  return { ...fact, authorityBindingDigest: authorityBindingDigest(fact) };
}
