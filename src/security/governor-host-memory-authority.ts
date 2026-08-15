/** Host-owned monotonic authority for verified memory generations. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { assertGovernorJsonResources } from "../tasks/governor/resource-guard.js";
import { assertGovernorBoundarySafe } from "../tasks/governor/secret-filter.js";
import type {
  GovernorHostAntiRollbackLedger,
  GovernorLedgerOrdering,
  GovernorLedgerState,
  GovernorMemoryRetirementReason,
} from "./governor-host-anti-rollback-ledger.js";

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
  authority: number;
  authorityRank: number;
  generation: number;
  sourceEvidenceId: string;
  sourceEvidenceLineage: readonly string[];
  sourceMemoryLineage: readonly string[];
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
  retirementReason?: GovernorMemoryRetirementReason;
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
  retire: (
    binding: GovernorMemoryAuthorityBinding,
    reason?: GovernorMemoryRetirementReason,
  ) => GovernorMemoryAuthorityState;
  state: (scopeKey: string, factKey: string) => GovernorMemoryAuthorityState | null;
  matches: (
    binding: GovernorMemoryAuthorityBinding,
    generation: number,
    bindingDigest: string,
  ) => boolean;
}>;

const AUTHORITIES = new WeakSet<object>();
const CLOSERS = new WeakMap<object, () => void>();
const authorityKey = (scopeKey: string, factKey: string) =>
  governorDigest({ kind: "memory-fact", scopeKey, factKey });
const authorityBinding = (binding: GovernorMemoryAuthorityBinding) =>
  governorDigest(
    assertGovernorBoundarySafe(
      "memory",
      assertGovernorJsonResources({ kind: "memory-current", ...binding }),
    ),
  );

function toState(state: GovernorLedgerState | null): GovernorMemoryAuthorityState | null {
  if (!state || (state.status !== "memory_current" && state.status !== "memory_retired")) {
    return null;
  }
  return {
    generation: state.generation,
    status: state.status === "memory_current" ? "current" : "retired",
    bindingDigest: state.bindingDigest,
    ledgerDigest: state.digest,
    ...(state.retirementReason ? { retirementReason: state.retirementReason } : {}),
    ...(state.ordering ? { ordering: state.ordering } : {}),
  };
}

function rejectAdvance(
  current: GovernorLedgerState,
  binding: GovernorMemoryAuthorityBinding,
): Exclude<GovernorMemoryAuthorityAdvance, { accepted: true }> | null {
  const state = toState(current) as GovernorMemoryAuthorityState;
  const prior = current.ordering;
  const next = binding.ordering;
  if (!prior) {
    return { accepted: false, state, reason: "legacy_high_water" };
  }
  if (next.scopeEpoch < prior.scopeEpoch || next.observedAt < prior.observedAt) {
    return { accepted: false, state, reason: "stale" };
  }
  if (
    current.status === "memory_retired" &&
    (current.retirementReason === "expiry"
      ? next.scopeEpoch < prior.scopeEpoch
      : next.scopeEpoch <= prior.scopeEpoch)
  ) {
    return { accepted: false, state, reason: "retired" };
  }
  if (
    next.taskDigest === prior.taskDigest &&
    (next.objectiveRevision < prior.objectiveRevision ||
      (next.objectiveRevision === prior.objectiveRevision &&
        next.planVersion < prior.planVersion) ||
      (next.objectiveRevision === prior.objectiveRevision &&
        next.planVersion === prior.planVersion &&
        next.taskVersion < prior.taskVersion))
  ) {
    return { accepted: false, state, reason: "fence_regression" };
  }
  if (
    next.scopeEpoch === prior.scopeEpoch &&
    (next.sourceRank < prior.sourceRank ||
      (next.sourceRank === prior.sourceRank &&
        next.confidenceMillionths < prior.confidenceMillionths))
  ) {
    return { accepted: false, state, reason: "weaker" };
  }
  if (
    next.scopeEpoch === prior.scopeEpoch &&
    next.observedAt === prior.observedAt &&
    next.sourceRank === prior.sourceRank &&
    next.confidenceMillionths === prior.confidenceMillionths
  ) {
    return { accepted: false, state, reason: "stale" };
  }
  return null;
}

/** Created only by the trusted host persistence bootstrap. */
export function createGovernorMemoryAuthority(
  ledger: GovernorHostAntiRollbackLedger,
  afterLedgerAppend?: () => void,
): GovernorTrustedMemoryAuthority {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  };
  const authority: GovernorTrustedMemoryAuthority = Object.freeze({
    advance: (binding) => {
      assertOpen();
      const key = authorityKey(binding.scopeKey, binding.factKey);
      const current = ledger.state("memory", key);
      if (
        current?.status === "memory_current" &&
        current.bindingDigest === authorityBinding(binding)
      ) {
        return { accepted: true, state: toState(current) as GovernorMemoryAuthorityState };
      }
      if (current) {
        const rejection = rejectAdvance(current, binding);
        if (rejection) {
          return rejection;
        }
      }
      const generation = (current?.generation ?? 0) + 1;
      const finalBinding = { ...binding, generation };
      const next = ledger.append({
        kind: "memory",
        key,
        generation,
        status: "memory_current",
        bindingDigest: authorityBinding(finalBinding),
        ordering: binding.ordering,
      });
      afterLedgerAppend?.();
      return { accepted: true, state: toState(next) as GovernorMemoryAuthorityState };
    },
    retire: (binding, retirementReason: GovernorMemoryRetirementReason = "explicit_forget") => {
      assertOpen();
      assertGovernorBoundarySafe("memory", assertGovernorJsonResources(binding));
      const key = authorityKey(binding.scopeKey, binding.factKey);
      const digest = governorDigest({
        kind: "memory-retired",
        retirementReason,
        ...binding,
      } as unknown as import("../tasks/governor/canonical-json.js").GovernorJsonValue);
      const legacyDigest = governorDigest({
        kind: "memory-retired",
        ...binding,
      } as unknown as import("../tasks/governor/canonical-json.js").GovernorJsonValue);
      const current = ledger.state("memory", key);
      if (
        current?.status === "memory_retired" &&
        (current.bindingDigest === digest ||
          (current.retirementReason === undefined && current.bindingDigest === legacyDigest))
      ) {
        return toState(current) as GovernorMemoryAuthorityState;
      }
      if (
        current &&
        (current.status !== "memory_current" || current.bindingDigest !== authorityBinding(binding))
      ) {
        throw new Error("Governor memory retirement does not match current host authority");
      }
      const next = ledger.append({
        kind: "memory",
        key,
        generation: (current?.generation ?? 0) + 1,
        status: "memory_retired",
        bindingDigest: digest,
        retirementReason,
        ordering: binding.ordering,
      });
      afterLedgerAppend?.();
      return toState(next) as GovernorMemoryAuthorityState;
    },
    state: (scopeKey, factKey) => {
      assertOpen();
      return toState(ledger.state("memory", authorityKey(scopeKey, factKey)));
    },
    matches: (binding, generation, bindingDigest) => {
      assertOpen();
      authorityBinding(binding);
      const current = ledger.state("memory", authorityKey(binding.scopeKey, binding.factKey));
      return (
        current?.status === "memory_current" &&
        current.generation === generation &&
        current.bindingDigest === bindingDigest &&
        bindingDigest === authorityBinding(binding)
      );
    },
  });
  AUTHORITIES.add(authority);
  CLOSERS.set(authority, () => {
    closed = true;
  });
  return authority;
}

export function isTrustedGovernorMemoryAuthority(value: GovernorTrustedMemoryAuthority): boolean {
  return AUTHORITIES.has(value);
}

export function closeGovernorMemoryAuthority(value: GovernorTrustedMemoryAuthority): void {
  CLOSERS.get(value)?.();
}
