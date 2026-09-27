import {
  createGovernorMemoryRetirementDecision,
  type MemoryGovernorRetirementDecision,
} from "../plugins/memory-governor-capability.js";
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
  retirementDecision?: MemoryGovernorRetirementDecision;
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
    params: Readonly<{
      reason: GovernorMemoryRetirementReason;
      semanticCutoff: number;
      issuedAt: number;
    }>,
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
    ...(state.memoryRetirement ? { retirementDecision: state.memoryRetirement } : {}),
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
      ? next.scopeEpoch < prior.scopeEpoch || next.observedAt <= prior.observedAt
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
  signingKey?: string,
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
    retire: (binding, params) => {
      assertOpen();
      if (!signingKey) {
        throw new Error("GOVERNOR_MEMORY_AUTHORITY_KEY_REQUIRED");
      }
      assertGovernorBoundarySafe("memory", assertGovernorJsonResources(binding));
      const { reason: retirementReason, semanticCutoff, issuedAt } = params;
      const key = authorityKey(binding.scopeKey, binding.factKey);
      const current = ledger.state("memory", key);
      if (current?.status === "memory_retired" && current.memoryRetirement) {
        const prior = current.memoryRetirement;
        if (
          prior.scopeKey !== binding.scopeKey ||
          prior.factKey !== binding.factKey ||
          prior.staleMemoryId !== binding.memoryId ||
          prior.reason !== retirementReason ||
          prior.semanticCutoff !== semanticCutoff ||
          prior.priorAuthorityBindingDigest !== authorityBinding(binding)
        ) {
          throw new Error("GOVERNOR_MEMORY_RETIREMENT_CONFLICT");
        }
        return toState(current) as GovernorMemoryAuthorityState;
      }
      if (
        current &&
        (current.status !== "memory_current" || current.bindingDigest !== authorityBinding(binding))
      ) {
        throw new Error("Governor memory retirement does not match current host authority");
      }
      const priorGeneration = current?.generation ?? binding.generation;
      const retirementDecision = createGovernorMemoryRetirementDecision(
        {
          scopeKey: binding.scopeKey,
          factKey: binding.factKey,
          staleMemoryId: binding.memoryId,
          priorGeneration,
          newGeneration: priorGeneration + 1,
          semanticCutoff,
          issuedAt,
          reason: retirementReason,
          priorAuthorityBindingDigest: authorityBinding(binding),
        },
        signingKey,
      );
      const next = ledger.append({
        kind: "memory",
        key,
        generation: retirementDecision.newGeneration,
        status: "memory_retired",
        bindingDigest: retirementDecision.retirementBindingDigest,
        retirementReason,
        memoryRetirement: retirementDecision,
        ordering: {
          ...binding.ordering,
          observedAt: semanticCutoff,
          recordedAt: Math.max(binding.ordering.recordedAt, issuedAt, semanticCutoff),
        },
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
