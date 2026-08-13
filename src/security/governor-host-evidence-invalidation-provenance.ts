import type {
  GovernorEvidenceInvalidationProvenance,
  GovernorEvidenceInvalidationReason,
} from "./governor-host-contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export function assertGovernorEvidenceInvalidationProvenance(
  reasonCode: GovernorEvidenceInvalidationReason,
  provenance: GovernorEvidenceInvalidationProvenance,
  scopeKey: string,
  observedAt: number,
): void {
  const value = provenance as unknown as Record<string, unknown>;
  const assertKeys = (keys: readonly string[]) => {
    if (Object.keys(value).some((key) => !keys.includes(key))) {
      throw new Error("Governor evidence invalidation provenance is invalid");
    }
  };
  if (reasonCode === "contradicted_by_newer_evidence") {
    assertKeys([
      "kind",
      "sourceEvidenceId",
      "sourceEvidenceDigest",
      "sourceObservedAt",
      "sourceScopeKey",
      "confidence",
      "authority",
    ]);
    if (
      provenance.kind !== "newer_evidence" ||
      !provenance.sourceEvidenceId.trim() ||
      !SHA256.test(provenance.sourceEvidenceDigest) ||
      provenance.sourceScopeKey !== scopeKey ||
      provenance.confidence !== "high" ||
      provenance.authority !== "authenticated_host" ||
      !Number.isSafeInteger(provenance.sourceObservedAt) ||
      provenance.sourceObservedAt > observedAt
    ) {
      throw new Error("Governor evidence invalidation provenance is invalid");
    }
    return;
  }
  if (reasonCode === "scope_revoked") {
    assertKeys(["kind", "scopeEpoch", "authorityDigest"]);
    if (
      provenance.kind !== "scope_revocation" ||
      !Number.isSafeInteger(provenance.scopeEpoch) ||
      provenance.scopeEpoch < 0 ||
      !SHA256.test(provenance.authorityDigest)
    ) {
      throw new Error("Governor evidence invalidation provenance is invalid");
    }
    return;
  }
  if (reasonCode === "freshness_expired") {
    assertKeys(["kind", "freshnessExpiresAt", "policyDigest"]);
    if (
      provenance.kind !== "freshness_policy" ||
      !Number.isSafeInteger(provenance.freshnessExpiresAt) ||
      provenance.freshnessExpiresAt > observedAt ||
      !SHA256.test(provenance.policyDigest)
    ) {
      throw new Error("Governor evidence invalidation provenance is invalid");
    }
    return;
  }
  if (
    provenance.kind !== "operator_instruction" ||
    !SHA256.test(provenance.operatorReceiptDigest)
  ) {
    throw new Error("Governor evidence invalidation provenance is invalid");
  }
  assertKeys(["kind", "operatorReceiptDigest"]);
}
