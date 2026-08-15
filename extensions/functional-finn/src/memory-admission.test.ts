import { describe, expect, it, vi } from "vitest";
import {
  FunctionalFinnEvidenceStore,
  type FunctionalFinnStoredEvidence,
} from "./evidence-store.js";
import { admitFunctionalFinnMemory } from "./memory-admission.js";
import { FunctionalFinnMemoryLedger, type FunctionalFinnMemoryRecord } from "./memory-ledger.js";

function stores() {
  const evidenceValues = new Map<string, FunctionalFinnStoredEvidence>();
  const memoryValues = new Map<string, FunctionalFinnMemoryRecord>();
  const atomic = <T>(values: Map<string, T>) => ({
    registerIfAbsent: (key: string, value: T) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: (key: string) => values.get(key),
    entries: () => [...values].map(([key, value]) => ({ key, value })),
    update: (key: string, mutate: (value: T | undefined) => T | undefined) => {
      const next = mutate(values.get(key));
      if (next === undefined) {
        values.delete(key);
      } else {
        values.set(key, next);
      }
      return true;
    },
  });
  return {
    evidence: new FunctionalFinnEvidenceStore(atomic(evidenceValues)),
    ledger: new FunctionalFinnMemoryLedger(atomic(memoryValues)),
  };
}

describe("Functional Finn memory admission", () => {
  it("admits an exact user-confirmed span and materializes before success", async () => {
    const { evidence, ledger } = stores();
    const source = evidence.recordUserConfirmation({
      agentId: "finn",
      runId: "r",
      content: "My timezone is Chicago.",
      observedAt: 100,
    });
    const reconcile = vi.fn(async () => {
      const record = ledger.lookup("finn", "user.timezone");
      if (record) {
        ledger.markRemediated({
          agentId: record.agentId,
          factKey: record.factKey,
          revisionDigest: record.revisionDigest,
          attemptId: "projection-1",
        });
      }
    });
    const result = await admitFunctionalFinnMemory({
      input: {
        factKey: "user.timezone",
        claim: "The user's timezone is Chicago.",
        sourceEvidenceId: source.evidenceId,
        sourceStart: 15,
        sourceEnd: 22,
        sourceQuote: "Chicago",
      },
      agentId: "finn",
      now: 101,
      evidence,
      ledger,
      verifySupport: async () => true,
      reconcile,
    });
    expect(result.remediation).toEqual({ state: "applied", attemptId: "projection-1" });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong scope", { agentId: "other", start: 15, end: 22, quote: "Chicago" }],
    ["wrong span", { agentId: "finn", start: 0, end: 7, quote: "Chicago" }],
  ])("rejects %s without materialization", async (_name, variant) => {
    const { evidence, ledger } = stores();
    const source = evidence.recordUserConfirmation({
      agentId: "finn",
      runId: "r",
      content: "My timezone is Chicago.",
      observedAt: 100,
    });
    const reconcile = vi.fn(async () => undefined);
    await expect(
      admitFunctionalFinnMemory({
        input: {
          factKey: "user.timezone",
          claim: "The user's timezone is Chicago.",
          sourceEvidenceId: source.evidenceId,
          sourceStart: variant.start,
          sourceEnd: variant.end,
          sourceQuote: variant.quote,
        },
        agentId: variant.agentId,
        now: 101,
        evidence,
        ledger,
        verifySupport: async () => true,
        reconcile,
      }),
    ).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects an unsupported model-proposed claim before durable admission", async () => {
    const { evidence, ledger } = stores();
    const source = evidence.recordUserConfirmation({
      agentId: "finn",
      runId: "r",
      content: "My timezone is Chicago.",
      observedAt: 100,
    });
    await expect(
      admitFunctionalFinnMemory({
        input: {
          factKey: "user.timezone",
          claim: "The user's timezone is Tokyo.",
          sourceEvidenceId: source.evidenceId,
          sourceStart: 15,
          sourceEnd: 22,
          sourceQuote: "Chicago",
        },
        agentId: "finn",
        now: 101,
        evidence,
        ledger,
        verifySupport: async () => false,
        reconcile: async () => undefined,
      }),
    ).rejects.toThrow("not supported");
    expect(ledger.recall({ agentId: "finn", now: 101 })).toEqual([]);
  });
});
