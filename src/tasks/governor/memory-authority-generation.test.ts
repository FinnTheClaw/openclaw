import { describe, expect, it } from "vitest";
import type { GovernorLedgerState } from "../../security/governor-host-anti-rollback-ledger.js";
import {
  createGovernorMemoryAuthority,
  type GovernorMemoryAuthorityBinding,
} from "../../security/governor-host-memory-authority.js";
import { governorDigest } from "./canonical-json.js";

function binding(generation: number, observedAt: number): GovernorMemoryAuthorityBinding {
  return {
    scopeKey: "scope-a",
    factKey: "fixture.endpoint",
    scopeEpoch: 0,
    memoryId: `memory-${generation}`,
    sourceKind: "structured_external",
    sourceIdentity: "opaque:source",
    sourceReference: "opaque:reference",
    freshnessExpiresAt: null,
    sensitivity: "normal",
    authority: 0.6,
    authorityRank: 600,
    generation,
    sourceEvidenceId: `evidence-${generation}`,
    sourceEvidenceLineage: [],
    sourceMemoryLineage: [],
    factDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    provenanceDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
    semanticDigest: "e".repeat(64),
    ordering: {
      scopeEpoch: 0,
      observedAt,
      recordedAt: observedAt,
      sourceRank: 600,
      confidenceMillionths: 900_000,
      taskVersion: 1,
      objectiveRevision: 1,
      planVersion: 1,
      taskDigest: "f".repeat(64),
    },
  };
}

describe("governor memory authority generation binding", () => {
  it("computes the digest after allocating each final generation", () => {
    const rows = new Map<string, GovernorLedgerState>();
    let sequence = 0;
    const authority = createGovernorMemoryAuthority({
      append(input) {
        const row: GovernorLedgerState = {
          ...input,
          digest: `ledger-digest-${++sequence}`,
        };
        rows.set(`${input.kind}:${input.key}`, row);
        return row;
      },
      state(kind, key) {
        return rows.get(`${kind}:${key}`) ?? null;
      },
    });

    for (const [next, observedAt] of [
      [1, 100],
      [2, 200],
    ] as const) {
      const source = binding(0, observedAt);
      const decision = authority.advance(source);
      expect(decision).toMatchObject({ accepted: true, state: { generation: next } });
      expect(decision.accepted && decision.state.bindingDigest).toBe(
        governorDigest({ kind: "memory-current", ...source, generation: next }),
      );
    }
  });

  it("permits a newer same-scope observation after expiry retirement", () => {
    const rows = new Map<string, GovernorLedgerState>();
    const authority = createGovernorMemoryAuthority({
      append(input) {
        const row: GovernorLedgerState = { ...input, digest: "ledger-digest" };
        rows.set(`${input.kind}:${input.key}`, row);
        return row;
      },
      state(kind, key) {
        return rows.get(`${kind}:${key}`) ?? null;
      },
    });
    const original = binding(0, 100);
    expect(authority.advance(original)).toMatchObject({ accepted: true, state: { generation: 1 } });
    expect(authority.retire({ ...original, generation: 1 })).toMatchObject({
      status: "retired",
      generation: 2,
    });
    expect(authority.advance(binding(0, 200))).toMatchObject({
      accepted: true,
      state: { generation: 3, status: "current" },
    });
  });
});
