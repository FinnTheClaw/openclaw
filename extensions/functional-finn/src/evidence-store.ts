import { createHash } from "node:crypto";
import type { FunctionalFinnEvidence } from "./answer-envelope.js";

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

function serializeResult(result: unknown): string {
  const text =
    typeof result === "string"
      ? result
      : JSON.stringify(result, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
  return (text ?? String(result)).slice(0, 64 * 1024);
}

export class FunctionalFinnEvidenceStore {
  constructor(private readonly store: SyncStore<FunctionalFinnStoredEvidence>) {}

  recordToolObservation(params: {
    agentId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    result: unknown;
    observedAt: number;
    freshnessMs?: number;
  }): FunctionalFinnStoredEvidence {
    const content = serializeResult(params.result);
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const evidenceId = `tool:${params.runId}:${params.toolCallId}:${digest}`;
    const value: FunctionalFinnStoredEvidence = {
      evidenceId,
      agentId: params.agentId,
      runId: params.runId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      content,
      observedAt: params.observedAt,
      freshnessUntil: params.observedAt + (params.freshnessMs ?? 10 * 60 * 1_000),
      sourceKind: "tool_observation",
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

  recordUserConfirmation(params: {
    agentId: string;
    runId: string;
    content: string;
    observedAt: number;
  }): FunctionalFinnStoredEvidence {
    const content = params.content.slice(0, 64 * 1024);
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

  lookup(evidenceId: string): FunctionalFinnEvidence | undefined {
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
