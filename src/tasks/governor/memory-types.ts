import type { GovernorJsonValue } from "./canonical-json.js";

export type GovernorMemoryStatus =
  | "candidate"
  | "verified"
  | "quarantined"
  | "superseded"
  | "tombstoned";

export type GovernorMemorySourceKind =
  | "structured_external"
  | "authenticated_user"
  | "tool"
  | "historical_memory"
  | "untrusted_candidate"
  | "assistant_text"
  | "hidden_reasoning";

export type GovernorMemoryProvenance = {
  sourceRef: string;
  observedAt: number;
  scopeKey: string;
  confidence: number;
  sensitivity: "normal" | "sensitive";
};

export type GovernorMemoryRecord = {
  memoryId: string;
  scopeKey: string;
  scopeEpoch: number;
  factKey: string;
  status: GovernorMemoryStatus;
  sourceKind: GovernorMemorySourceKind;
  sourceIdentity: string;
  sourceRank: number;
  observedAt: number;
  freshnessExpiresAt?: number;
  confidence: number;
  sensitivity: "normal" | "sensitive";
  provenance: GovernorMemoryProvenance;
  content: GovernorJsonValue;
  contentDigest: string;
  verifiedEvidenceTaskId?: string;
  verifiedEvidenceId?: string;
  verifiedEvidenceDigest?: string;
  verifiedEvidenceSemanticDigest?: string;
  supersedesId?: string;
  supersededAt?: number;
  supersededEvidenceId?: string;
  supersededEvidenceDigest?: string;
  supersededReason?: string;
  contradictionFingerprint?: string;
  replacementMemoryId?: string;
  createdAt: number;
  updatedAt: number;
  tombstonedAt?: number;
};

export type GovernorMemoryWriteResult =
  | { stored: true; memory: GovernorMemoryRecord }
  | {
      stored: false;
      reason: "scope_epoch_conflict" | "provenance_rejected" | "fact_version_conflict";
      currentEpoch: number;
    };

export type GovernorForgetResult =
  | {
      status: "deleted";
      memoryId: string;
      scopeEpoch: number;
      invalidated: readonly ["primary", "scope_epoch"];
    }
  | { status: "not_found"; memoryId: string; scopeEpoch: number }
  | { status: "partial_failure"; memoryId: string; scopeEpoch: number; failed: readonly string[] };

export const GOVERNOR_MEMORY_SOURCE_RANK: Readonly<Record<GovernorMemorySourceKind, number>> = {
  structured_external: 600,
  authenticated_user: 500,
  tool: 400,
  historical_memory: 200,
  untrusted_candidate: 0,
  assistant_text: 0,
  hidden_reasoning: 0,
};

/** Canonicalizes a fact key without changing its meaning or permitting emptiness. */
export function normalizeGovernorFactKey(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Governor fact key must be a string");
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/gu, ".")
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/[.:-]{2,}/gu, (run) => run[0] ?? "")
    .replace(/^[.:-]+|[.:-]+$/gu, "");
  if (!normalized) {
    throw new Error("Governor fact key must not be empty");
  }
  return normalized;
}
