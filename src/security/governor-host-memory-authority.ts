/** Read-only contract for host-owned verified-memory generation authority. */
import type { GovernorLedgerOrdering } from "./governor-host-anti-rollback-ledger.js";

export type GovernorMemoryAuthorityBinding = Readonly<{
  scopeKey: string;
  factKey: string;
  scopeEpoch: number;
  memoryId: string;
  sourceKind: string;
  sourceIdentity: string;
  sourceReference: string;
  freshnessExpiresAt: number | null;
  sensitivity: string;
  factDigest: string;
  contentDigest: string;
  provenanceDigest: string;
  evidenceDigest: string;
  semanticDigest: string;
  ordering: GovernorLedgerOrdering;
}>;

export type GovernorMemoryAuthorityState = Readonly<{
  generation: number;
  status: "current" | "retired";
  bindingDigest: string;
  ledgerDigest: string;
  ordering?: GovernorLedgerOrdering;
}>;

export type GovernorMemoryAuthorityAdvance =
  | Readonly<{ accepted: true; state: GovernorMemoryAuthorityState }>
  | Readonly<{
      accepted: false;
      state: GovernorMemoryAuthorityState;
      reason: "legacy_high_water" | "retired" | "stale" | "weaker" | "fence_regression";
    }>;

export type GovernorTrustedMemoryAuthority = Readonly<{
  advance: (binding: GovernorMemoryAuthorityBinding) => GovernorMemoryAuthorityAdvance;
  retire: (binding: GovernorMemoryAuthorityBinding) => GovernorMemoryAuthorityState;
  state: (scopeKey: string, factKey: string) => GovernorMemoryAuthorityState | null;
  matches: (
    binding: GovernorMemoryAuthorityBinding,
    generation: number,
    bindingDigest: string,
  ) => boolean;
}>;
