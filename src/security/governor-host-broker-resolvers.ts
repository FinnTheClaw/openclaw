import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  GovernorAuthenticatedApprovalReceipt,
  GovernorTrustedApprovalResolver,
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedReceiptResolver,
  HostBrokerState,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";
import type { GovernorHostPersistence } from "./governor-host-persistence.js";
import type { GovernorSecrets } from "./governor-host-secrets.js";

const RECEIPT_RESOLVERS = new WeakSet<object>();
const EVIDENCE_RESOLVERS = new WeakSet<object>();
const APPROVAL_RESOLVERS = new WeakSet<object>();

export function isTrustedGovernorReceiptResolver(resolver: GovernorTrustedReceiptResolver) {
  return RECEIPT_RESOLVERS.has(resolver);
}
export function isTrustedGovernorEvidenceInvalidationResolver(
  resolver: GovernorTrustedEvidenceInvalidationResolver,
) {
  return EVIDENCE_RESOLVERS.has(resolver);
}
export function isTrustedGovernorApprovalResolver(resolver: GovernorTrustedApprovalResolver) {
  return APPROVAL_RESOLVERS.has(resolver);
}

export function createHostBrokerResolvers(params: {
  state: HostBrokerState;
  secrets: GovernorSecrets;
  persistence: GovernorHostPersistence;
  assertOpen: () => void;
  sign: (key: string, value: GovernorJsonValue) => string;
}): {
  resolver: GovernorTrustedReceiptResolver;
  evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
  approvalResolver: GovernorTrustedApprovalResolver;
} {
  const rawResolver: GovernorTrustedReceiptResolver = Object.freeze({
    resolve: (receiptId, scopeKey) => {
      const receipt = params.state.receipts.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const body = {
        scopeKey: receipt.scopeKey,
        taskId: receipt.taskId,
        taskVersion: receipt.taskVersion,
        objectiveRevision: receipt.objectiveRevision,
        planVersion: receipt.planVersion,
        sourceKind: receipt.sourceKind,
        sourceIdentity: receipt.sourceIdentity,
        payloadDigest: governorDigest(receipt.payload),
        observedAt: receipt.observedAt,
      };
      return params.sign(params.state.key, { id: receipt.id, ...body }) === receipt.signature
        ? receipt
        : null;
    },
  });
  const resolver = Object.freeze({
    resolve: (receiptId: HostGovernorReceiptId, scopeKey: string) => {
      params.assertOpen();
      return rawResolver.resolve(receiptId, scopeKey);
    },
  }) satisfies GovernorTrustedReceiptResolver;
  RECEIPT_RESOLVERS.add(resolver);

  const rawEvidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver =
    Object.freeze({
      resolveEvidenceInvalidation: (receiptId, scopeKey) => {
        const receipt = params.state.evidenceInvalidations.get(receiptId);
        if (!receipt || receipt.scopeKey !== scopeKey) {
          return null;
        }
        const { signature, ...body } = receipt;
        return params.sign(params.state.key, body) === signature ? receipt : null;
      },
    });
  const evidenceInvalidationResolver = Object.freeze({
    resolveEvidenceInvalidation: (
      receiptId: import("./governor-host-contracts.js").HostGovernorEvidenceInvalidationReceiptId,
      scopeKey: string,
    ) => {
      params.assertOpen();
      return rawEvidenceInvalidationResolver.resolveEvidenceInvalidation(receiptId, scopeKey);
    },
  }) satisfies GovernorTrustedEvidenceInvalidationResolver;
  EVIDENCE_RESOLVERS.add(evidenceInvalidationResolver);

  const approvalReceiptCurrent = (receipt: GovernorAuthenticatedApprovalReceipt): boolean => {
    const { signature, ...body } = receipt;
    return (
      params.sign(params.state.key, body) === signature &&
      params.persistence.approvalLedgerMatches({
        grantId: receipt.grantId,
        scopeKey: receipt.scopeKey,
        approvalEpoch: receipt.approvalEpoch,
      })
    );
  };
  const rawApprovalResolver: GovernorTrustedApprovalResolver = Object.freeze({
    resolveApproval: (receiptId, scopeKey) => {
      const receipt = params.state.approvals.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return params.sign(params.state.key, body) === signature &&
        params.persistence.approvalGrantMatches({
          grantId: receipt.grantId,
          scopeKey: receipt.scopeKey,
          approvalEpoch: receipt.approvalEpoch,
        })
        ? receipt
        : null;
    },
    resolveRevocation: (receiptId, scopeKey) => {
      const receipt = params.state.revocations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return params.sign(params.state.key, body) === signature ? receipt : null;
    },
    verifyApprovalReceiptCurrent: approvalReceiptCurrent,
    verifyApprovalGrant: (grant, canonicalTarget) => {
      if (grant.authorityKeyId !== "host-broker-v1" || grant.authorityVersion !== 1) {
        return false;
      }
      const canonicalTargetOpaque = /^[a-f0-9]{64}$/u.test(canonicalTarget)
        ? canonicalTarget
        : params.secrets.identity.opaqueReference("action-target", canonicalTarget);
      if (canonicalTargetOpaque !== grant.canonicalTarget) {
        return false;
      }
      const payload = {
        grantId: grant.grantId,
        taskId: grant.taskId,
        scopeKey: grant.scopeKey,
        objectiveRevision: grant.objectiveRevision,
        capability: grant.capability,
        capabilityVersion: grant.capabilityVersion,
        canonicalTargetOpaque: grant.canonicalTarget,
        approvalReceiptId: grant.issuerId,
        approvalEpoch: grant.approvalEpoch,
        expiresAt: grant.expiresAt,
      };
      return (
        params.sign(params.state.key, payload) === grant.authoritySignature &&
        params.persistence.approvalLedgerMatches({
          grantId: grant.grantId,
          scopeKey: grant.scopeKey,
          approvalEpoch: grant.approvalEpoch,
        })
      );
    },
  });
  const approvalResolver = Object.freeze({
    resolveApproval: (...args: Parameters<GovernorTrustedApprovalResolver["resolveApproval"]>) => {
      params.assertOpen();
      return rawApprovalResolver.resolveApproval(...args);
    },
    resolveRevocation: (
      ...args: Parameters<GovernorTrustedApprovalResolver["resolveRevocation"]>
    ) => {
      params.assertOpen();
      return rawApprovalResolver.resolveRevocation(...args);
    },
    verifyApprovalReceiptCurrent: (
      ...args: Parameters<GovernorTrustedApprovalResolver["verifyApprovalReceiptCurrent"]>
    ) => {
      params.assertOpen();
      return rawApprovalResolver.verifyApprovalReceiptCurrent(...args);
    },
    verifyApprovalGrant: (
      ...args: Parameters<GovernorTrustedApprovalResolver["verifyApprovalGrant"]>
    ) => {
      params.assertOpen();
      return rawApprovalResolver.verifyApprovalGrant(...args);
    },
  }) satisfies GovernorTrustedApprovalResolver;
  APPROVAL_RESOLVERS.add(approvalResolver);
  return { resolver, evidenceInvalidationResolver, approvalResolver };
}
