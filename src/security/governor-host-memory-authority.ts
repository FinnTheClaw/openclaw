/** Host-owned monotonic authority for verified memory generations. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type {
  GovernorHostAntiRollbackLedger,
  GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";

export type GovernorMemoryAuthorityBinding = Readonly<{
  scopeKey: string;
  factKey: string;
  memoryId: string;
  evidenceDigest: string;
  semanticDigest: string;
}>;

export type GovernorMemoryAuthorityState = Readonly<{
  generation: number;
  status: "current" | "retired";
  bindingDigest: string;
  ledgerDigest: string;
}>;

export type GovernorTrustedMemoryAuthority = Readonly<{
  advance: (binding: GovernorMemoryAuthorityBinding) => GovernorMemoryAuthorityState;
  retire: (binding: GovernorMemoryAuthorityBinding) => GovernorMemoryAuthorityState;
  state: (scopeKey: string, factKey: string) => GovernorMemoryAuthorityState | null;
  matches: (
    binding: GovernorMemoryAuthorityBinding,
    generation: number,
    bindingDigest: string,
  ) => boolean;
}>;

const AUTHORITIES = new WeakSet<object>();
const authorityKey = (scopeKey: string, factKey: string) =>
  governorDigest({ kind: "memory-fact", scopeKey, factKey });
const authorityBinding = (binding: GovernorMemoryAuthorityBinding) =>
  governorDigest({ kind: "memory-current", ...binding });

function toState(state: GovernorLedgerState | null): GovernorMemoryAuthorityState | null {
  if (!state || (state.status !== "memory_current" && state.status !== "memory_retired")) {
    return null;
  }
  return {
    generation: state.generation,
    status: state.status === "memory_current" ? "current" : "retired",
    bindingDigest: state.bindingDigest,
    ledgerDigest: state.digest,
  };
}

/** Created only by the trusted host persistence bootstrap. */
export function createGovernorMemoryAuthority(
  ledger: GovernorHostAntiRollbackLedger,
  afterLedgerAppend?: () => void,
): GovernorTrustedMemoryAuthority {
  const authority: GovernorTrustedMemoryAuthority = Object.freeze({
    advance: (binding) => {
      const key = authorityKey(binding.scopeKey, binding.factKey);
      const digest = authorityBinding(binding);
      const current = ledger.state("memory", key);
      if (current?.status === "memory_current" && current.bindingDigest === digest) {
        return toState(current) as GovernorMemoryAuthorityState;
      }
      const next = ledger.append({
        kind: "memory",
        key,
        generation: (current?.generation ?? 0) + 1,
        status: "memory_current",
        bindingDigest: digest,
      });
      afterLedgerAppend?.();
      return toState(next) as GovernorMemoryAuthorityState;
    },
    retire: (binding) => {
      const key = authorityKey(binding.scopeKey, binding.factKey);
      const digest = governorDigest({ kind: "memory-retired", ...binding });
      const current = ledger.state("memory", key);
      if (current?.status === "memory_retired" && current.bindingDigest === digest) {
        return toState(current) as GovernorMemoryAuthorityState;
      }
      const next = ledger.append({
        kind: "memory",
        key,
        generation: (current?.generation ?? 0) + 1,
        status: "memory_retired",
        bindingDigest: digest,
      });
      afterLedgerAppend?.();
      return toState(next) as GovernorMemoryAuthorityState;
    },
    state: (scopeKey, factKey) => toState(ledger.state("memory", authorityKey(scopeKey, factKey))),
    matches: (binding, generation, bindingDigest) => {
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
  return authority;
}

export function isTrustedGovernorMemoryAuthority(value: GovernorTrustedMemoryAuthority): boolean {
  return AUTHORITIES.has(value);
}
