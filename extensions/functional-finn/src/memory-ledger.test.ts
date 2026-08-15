import { describe, expect, it } from "vitest";
import { FunctionalFinnMemoryLedger, type FunctionalFinnMemoryRecord } from "./memory-ledger.js";
import { renderFunctionalFinnMemory } from "./memory-materializer.js";

function memoryStore() {
  const values = new Map<string, FunctionalFinnMemoryRecord>();
  return {
    values,
    store: {
      update(
        key: string,
        mutate: (
          current: FunctionalFinnMemoryRecord | undefined,
        ) => FunctionalFinnMemoryRecord | undefined,
      ) {
        const next = mutate(values.get(key));
        if (next) {
          values.set(key, structuredClone(next));
        } else {
          values.delete(key);
        }
        return true;
      },
      lookup: (key: string) => values.get(key),
      entries: () => [...values].map(([key, value]) => ({ key, value })),
    },
  };
}

const first = {
  agentId: "finn",
  factKey: "service.endpoint",
  claim: "The service endpoint is alpha.",
  sourceKind: "tool_observation" as const,
  evidenceId: "tool:1",
  observedAt: 100,
  freshnessUntil: 200,
  confidence: 0.99,
  authority: 10,
};

describe("Functional Finn verified memory ledger", () => {
  it("rejects model inference from active recall", () => {
    const { store } = memoryStore();
    const ledger = new FunctionalFinnMemoryLedger(store);
    expect(() => ledger.admit({ ...first, sourceKind: "model_inference" })).toThrow(
      /model inference/,
    );
  });

  it("atomically supersedes stale facts and invalidates the rendered projection", () => {
    const { store } = memoryStore();
    const ledger = new FunctionalFinnMemoryLedger(store);
    const old = ledger.admit(first).record;
    const replacement = ledger.admit({
      ...first,
      claim: "The service endpoint is beta.",
      evidenceId: "tool:2",
      observedAt: 150,
      freshnessUntil: 250,
    }).record;

    expect(replacement.generation).toBe(2);
    expect(replacement.history).toEqual([
      expect.objectContaining({
        generation: 1,
        evidenceId: "tool:1",
        retirementReason: "superseded",
      }),
    ]);
    expect(ledger.recall({ agentId: "finn", now: 160, factKey: first.factKey })).toEqual([
      replacement,
    ]);
    const rendered = renderFunctionalFinnMemory([replacement]);
    expect(rendered).toContain("endpoint is beta");
    expect(rendered).not.toContain("endpoint is alpha");
    expect(old.revisionDigest).not.toBe(replacement.revisionDigest);
  });

  it("rejects stale, weaker, and cross-scope replacement while preserving independent facts", () => {
    const { store } = memoryStore();
    const ledger = new FunctionalFinnMemoryLedger(store);
    ledger.admit(first);
    expect(() => ledger.admit({ ...first, evidenceId: "old", observedAt: 90 })).toThrow(
      /not newer/,
    );
    expect(() =>
      ledger.admit({ ...first, evidenceId: "weak", observedAt: 150, authority: 9 }),
    ).toThrow(/authoritative/);
    ledger.admit({ ...first, agentId: "other", evidenceId: "other:1" });
    expect(ledger.recall({ agentId: "other", now: 150 })).toHaveLength(1);
    expect(ledger.recall({ agentId: "finn", now: 150 })).toHaveLength(1);
  });

  it("replays exact evidence idempotently and persists across a ledger restart", () => {
    const fixture = memoryStore();
    const firstLedger = new FunctionalFinnMemoryLedger(fixture.store);
    const created = firstLedger.admit(first);
    expect(firstLedger.admit(first)).toEqual({ disposition: "replayed", record: created.record });

    const reopened = new FunctionalFinnMemoryLedger(fixture.store);
    expect(reopened.recall({ agentId: "finn", now: 150 })).toEqual([created.record]);
    expect(reopened.recall({ agentId: "finn", now: 201 })).toEqual([]);
  });

  it("keeps tombstones out of active recall", () => {
    const { store } = memoryStore();
    const ledger = new FunctionalFinnMemoryLedger(store);
    ledger.admit(first);
    const tombstone = ledger.admit({
      ...first,
      claim: undefined,
      tombstone: true,
      evidenceId: "tool:forget",
      observedAt: 160,
      freshnessUntil: 260,
    }).record;
    expect(tombstone.state).toBe("tombstone");
    expect(ledger.recall({ agentId: "finn", now: 170 })).toEqual([]);
  });
});
