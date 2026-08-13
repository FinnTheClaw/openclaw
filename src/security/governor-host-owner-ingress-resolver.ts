import crypto from "node:crypto";
import type {
  GovernorOwnerIngressClaim,
  GovernorTrustedOwnerIngressResolver,
  HostBrokerState,
} from "./governor-host-contracts.js";
import type { GovernorHostPersistence } from "./governor-host-persistence.js";
import type { GovernorSecrets } from "./governor-host-secrets.js";

const RESOLVERS = new WeakSet<object>();
const CLAIMS = new WeakSet<object>();
const LEASE_MS = 30_000;

export function isTrustedGovernorOwnerIngressResolver(
  resolver: GovernorTrustedOwnerIngressResolver,
): boolean {
  return RESOLVERS.has(resolver);
}

export function createHostOwnerIngressResolver(params: {
  state: HostBrokerState;
  key: string;
  secrets: GovernorSecrets;
  persistence: GovernorHostPersistence;
  assertOpen: () => void;
  sign: (
    key: string,
    value: import("../tasks/governor/canonical-json.js").GovernorJsonValue,
  ) => string;
  opaqueId: (
    key: string,
    value: import("../tasks/governor/canonical-json.js").GovernorJsonValue,
  ) => string;
}): GovernorTrustedOwnerIngressResolver {
  const rawResolver: GovernorTrustedOwnerIngressResolver = Object.freeze({
    claim: (receiptId, now) => {
      const receipt =
        params.state.ownerIngress.get(receiptId) ?? params.persistence.loadOwnerIngress(receiptId);
      if (
        !receipt ||
        receipt.consumedAt !== undefined ||
        receipt.expiresAt <= now ||
        receipt.deploymentIdentity !== params.secrets.deploymentIdentity
      ) {
        return null;
      }
      const { signature, consumedAt: _consumedAt, ...body } = receipt;
      if (params.sign(params.key, body) !== signature) {
        return null;
      }
      const claimToken = params.opaqueId(params.key, {
        ownerIngressClaim: receipt.id,
        nonce: crypto.randomUUID(),
      }) as import("./governor-host-contracts.js").HostGovernorOwnerIngressClaimToken;
      const claimAttemptIdentity = params.opaqueId(params.key, {
        ownerIngressAttempt: receipt.id,
        claimToken,
      });
      const leaseExpiresAt = Math.min(receipt.expiresAt, now + LEASE_MS);
      if (
        !params.persistence.claimOwnerIngress({
          receipt,
          claimToken,
          claimAttemptIdentity,
          now,
          leaseExpiresAt,
        })
      ) {
        return null;
      }
      params.state.ownerIngress.set(receiptId, receipt);
      const claim: GovernorOwnerIngressClaim = Object.freeze({
        receipt,
        claimToken,
        claimAttemptIdentity,
        leaseExpiresAt,
      });
      CLAIMS.add(claim);
      return claim;
    },
    finalize: (claim, taskId, now) => {
      if (!CLAIMS.has(claim) || !taskId.trim()) {
        return false;
      }
      const consumed = params.persistence.finalizeOwnerIngress({
        receipt: claim.receipt,
        claimToken: claim.claimToken,
        taskId,
        consumedAt: now,
      });
      if (consumed) {
        params.state.ownerIngress.set(
          claim.receipt.id,
          Object.freeze({ ...claim.receipt, consumedAt: now }),
        );
      }
      return consumed;
    },
  });
  const resolver = Object.freeze({
    claim: (...args: Parameters<GovernorTrustedOwnerIngressResolver["claim"]>) => {
      params.assertOpen();
      return rawResolver.claim(...args);
    },
    finalize: (...args: Parameters<GovernorTrustedOwnerIngressResolver["finalize"]>) => {
      params.assertOpen();
      return rawResolver.finalize(...args);
    },
  }) satisfies GovernorTrustedOwnerIngressResolver;
  RESOLVERS.add(resolver);
  return resolver;
}
