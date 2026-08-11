import { describe, expect, it } from "vitest";
import { governorDigest } from "./canonical-json.js";
import { opaqueEvidenceSourceRef, type GovernorEvidenceRecord } from "./evidence.js";
import {
  createGovernorMemoryEvidencePredicate,
  governorMemoryContradictionFingerprint,
  governorMemoryFactPredicate,
  isGovernorMemoryEvidencePredicate,
  normalizeGovernorFactKey,
  qualifyGovernorMemoryContradiction,
} from "./memory-contradiction-policy.js";
import type { GovernorMemoryRecord } from "./memory-integrity.js";
import { createGovernorIdentityContext } from "./types.js";

const identity = createGovernorIdentityContext("synthetic-v11-memory-policy-key");
const scope = "scope:principal-a/channel-signal/account-a/conversation-a";
const source = opaqueEvidenceSourceRef(
  "structured_external",
  "inventory:fixture-node-alpha",
  identity,
);

function memory(overrides: Partial<GovernorMemoryRecord> = {}): GovernorMemoryRecord {
  return {
    memoryId: "memory-current",
    scopeKey: scope,
    scopeEpoch: 0,
    factKey: "network.endpoint",
    status: "verified",
    sourceKind: "tool",
    sourceIdentity: "memory-source",
    sourceRank: 400,
    observedAt: 100,
    confidence: 1,
    sensitivity: "normal",
    provenance: {
      sourceRef: source,
      observedAt: 100,
      recordedAt: 100,
      scopeKey: scope,
      confidence: 1,
      sensitivity: "normal",
    },
    content: { host: "fixture-node-alpha", port: 9100 },
    contentDigest: governorDigest({ host: "fixture-node-alpha", port: 9100 }),
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function evidence(overrides: Partial<GovernorEvidenceRecord> = {}): GovernorEvidenceRecord {
  const value = { host: "fixture-node-alpha", port: 9200 };
  const predicate = governorMemoryFactPredicate("network.endpoint");
  return {
    evidenceId: "evidence-new",
    taskId: "task-v11" as GovernorEvidenceRecord["taskId"],
    criterionId: "criterion-memory",
    sourceKind: "tool",
    sourceIdentity: source,
    taskVersion: 1,
    objectiveRevision: 1,
    planVersion: 1,
    scopeKey: scope,
    observedAt: 101,
    payload: value,
    evidenceDigest: governorDigest(value),
    predicate,
    value,
    semanticDigest: governorDigest({ predicate, value }),
    admissibility: "admitted",
    createdAt: 101,
    admissionKeyId: "synthetic",
    admissionVersion: 1,
    admissionSignature: "synthetic-signature",
    ...overrides,
  };
}

function policy(overrides: Partial<GovernorEvidenceRecord> = {}) {
  const current = memory();
  return qualifyGovernorMemoryContradiction({
    memory: current,
    evidence: evidence(overrides),
    predicate: createGovernorMemoryEvidencePredicate({
      memory: current,
      factKey: " Network / Endpoint ",
    }),
    contradictionClass: "stale source",
  });
}

describe("memory contradiction policy", () => {
  it("normalizes non-empty fact keys and rejects empty keys", () => {
    expect(normalizeGovernorFactKey(" Network / Endpoint ")).toBe("network.endpoint");
    expect(() => normalizeGovernorFactKey(" / ")).toThrow();
  });

  it("retires for newer evidence from the same authority", () => {
    expect(policy({ observedAt: 101 })).toMatchObject({
      kind: "retire",
      reason: "newer_same_authority",
    });
  });

  it("retires for higher authority at the same observation time", () => {
    expect(policy({ sourceKind: "authenticated_user", observedAt: 100 })).toMatchObject({
      kind: "retire",
      reason: "higher_authority",
    });
  });

  it("rejects older or replayed evidence and lower authority", () => {
    expect(policy({ observedAt: 99 })).toMatchObject({ kind: "reject", reason: "older_evidence" });
    expect(
      qualifyGovernorMemoryContradiction({
        memory: memory({ sourceRank: 500 }),
        evidence: evidence({ observedAt: 101 }),
        predicate: createGovernorMemoryEvidencePredicate({
          memory: memory({ sourceRank: 500 }),
          factKey: "network.endpoint",
        }),
        contradictionClass: "stale source",
      }),
    ).toMatchObject({ kind: "reject", reason: "lower_authority" });
    expect(
      qualifyGovernorMemoryContradiction({
        memory: memory({ supersededEvidenceId: "evidence-new" }),
        evidence: evidence({ observedAt: 101 }),
        predicate: createGovernorMemoryEvidencePredicate({
          memory: memory(),
          factKey: "network.endpoint",
        }),
        contradictionClass: "stale source",
      }),
    ).toMatchObject({ kind: "reject", reason: "replayed_evidence" });
    expect(policy({ sourceKind: "tool", observedAt: 100 })).toMatchObject({
      kind: "unresolved",
      reason: "equal_authority_same_time",
    });
    expect(policy({ sourceKind: "tool", observedAt: 101 })).toMatchObject({
      kind: "retire",
      reason: "newer_same_authority",
    });
  });

  it("rejects different scope, predicate, same value, and malformed semantics", () => {
    expect(policy({ scopeKey: "scope:other-host" })).toMatchObject({
      kind: "reject",
      reason: "scope_mismatch",
    });
    expect(policy({ predicate: "network.other" })).toMatchObject({
      kind: "reject",
      reason: "predicate_mismatch",
    });
    expect(
      policy({
        payload: { host: "fixture-node-alpha", port: 9100 },
        evidenceDigest: governorDigest({ host: "fixture-node-alpha", port: 9100 }),
        value: { host: "fixture-node-alpha", port: 9100 },
        semanticDigest: governorDigest({
          predicate: governorMemoryFactPredicate("network.endpoint"),
          value: { host: "fixture-node-alpha", port: 9100 },
        }),
      }),
    ).toMatchObject({ kind: "reject", reason: "same_value" });
    expect(policy({ semanticDigest: "wrong" })).toMatchObject({
      kind: "reject",
      reason: "evidence_semantic_digest_mismatch",
    });
  });

  it("enforces admitted trusted sources and rejects assistant or memory candidates", () => {
    expect(policy({ sourceKind: "assistant_text" })).toMatchObject({
      kind: "reject",
      reason: "untrusted_source",
    });
    expect(policy({ sourceKind: "memory_candidate" })).toMatchObject({
      kind: "reject",
      reason: "untrusted_source",
    });
    expect(policy({ admissibility: "candidate" as "admitted" })).toMatchObject({
      kind: "reject",
      reason: "not_admitted",
    });
    expect(policy({ invalidatedAt: 102 })).toMatchObject({
      kind: "reject",
      reason: "invalidated_evidence",
    });
    expect(
      policy({ sourceIdentity: "raw-source" as GovernorEvidenceRecord["sourceIdentity"] }),
    ).toMatchObject({
      kind: "reject",
      reason: "invalid_source_reference",
    });
  });

  it("requires the authenticated receipt payload to contain the asserted memory value", () => {
    const payload = { host: "fixture-node-alpha", port: 9300 };
    expect(
      policy({
        payload,
        evidenceDigest: governorDigest(payload),
      }),
    ).toMatchObject({ kind: "reject", reason: "evidence_value_mismatch" });
  });

  it("leaves equal-authority same-time conflicts unresolved and deduplicatable", () => {
    const first = policy({ sourceIdentity: source, observedAt: 100 });
    const second = policy({ sourceIdentity: source, observedAt: 100, evidenceId: "different" });
    expect(first).toMatchObject({ kind: "unresolved", reason: "equal_authority_same_time" });
    expect(second).toMatchObject({ kind: "unresolved", reason: "equal_authority_same_time" });
    if (first.kind !== "unresolved" || second.kind !== "unresolved") {
      throw new Error("expected unresolved contradiction results");
    }
    expect(first).toHaveProperty("fingerprint", second.fingerprint);
  });

  it("uses exact predicate semantics and a deterministic opaque-source fingerprint", () => {
    const current = memory();
    const predicate = createGovernorMemoryEvidencePredicate({
      memory: current,
      factKey: "network.endpoint",
    });
    expect(isGovernorMemoryEvidencePredicate({ predicate, evidence: evidence() })).toBe(true);
    expect(
      governorMemoryContradictionFingerprint({
        sourceReference: source,
        factKey: " Network / Endpoint ",
        scopeKey: scope,
        contradictionClass: "stale source",
      }),
    ).toBe(
      governorMemoryContradictionFingerprint({
        sourceReference: source,
        factKey: "network.endpoint",
        scopeKey: scope,
        contradictionClass: "stale-source",
      }),
    );
  });
});
