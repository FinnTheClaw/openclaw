import { createHash } from "node:crypto";
import type { FunctionalFinnEvidence } from "./answer-envelope.js";
import { clipBoundedFunctionalFinnEvidenceText } from "./bounded-evidence.js";

export type FunctionalFinnStoredEvidence = FunctionalFinnEvidence & {
  runId: string;
  toolCallId: string;
  toolName: string;
};

type SyncStore<T> = {
  registerIfAbsent: (key: string, value: T, options?: { ttlMs?: number }) => boolean;
  lookup: (key: string) => T | undefined;
  entries: () => Array<{ key: string; value: T }>;
};

export class FunctionalFinnEvidenceStore {
  constructor(private readonly store: SyncStore<FunctionalFinnStoredEvidence>) {}

  recordUserConfirmation(params: {
    agentId: string;
    runId: string;
    content: string;
    observedAt: number;
  }): FunctionalFinnStoredEvidence {
    const content = clipBoundedFunctionalFinnEvidenceText(params.content);
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const evidenceId = `user:${params.runId}:${digest}`;
    const value: FunctionalFinnStoredEvidence = {
      evidenceId,
      agentId: params.agentId,
      runId: params.runId,
      toolCallId: "inbound",
      toolName: "user_message",
      content,
      observedAt: params.observedAt,
      freshnessUntil: params.observedAt + 24 * 60 * 60 * 1_000,
      sourceKind: "user_confirmed",
      state: "current",
    };
    if (!this.store.registerIfAbsent(evidenceId, value, { ttlMs: 24 * 60 * 60 * 1_000 })) {
      const existing = this.store.lookup(evidenceId);
      if (!existing || existing.content !== content || existing.agentId !== params.agentId) {
        throw new Error("evidence identity conflict");
      }
      return existing;
    }
    return value;
  }

  lookup(evidenceId: string): FunctionalFinnStoredEvidence | undefined {
    return this.store.lookup(evidenceId);
  }

  listRun(runId: string): FunctionalFinnEvidence[] {
    return this.store
      .entries()
      .map((entry) => entry.value)
      .filter((entry) => entry.runId === runId)
      .toSorted((a, b) => a.observedAt - b.observedAt || a.evidenceId.localeCompare(b.evidenceId))
      .slice(-50);
  }
}
