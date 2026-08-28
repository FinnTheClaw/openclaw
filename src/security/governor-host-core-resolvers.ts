import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedReceiptResolver,
  HostGovernorCoreState,
  HostGovernorEvidenceInvalidationReceiptId,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";

const RECEIPT_RESOLVERS = new WeakSet<object>();
const EVIDENCE_RESOLVERS = new WeakSet<object>();

export function isTrustedGovernorCoreReceiptResolver(
  resolver: GovernorTrustedReceiptResolver,
): boolean {
  return RECEIPT_RESOLVERS.has(resolver);
}

export function isTrustedGovernorCoreEvidenceInvalidationResolver(
  resolver: GovernorTrustedEvidenceInvalidationResolver,
): boolean {
  return EVIDENCE_RESOLVERS.has(resolver);
}

export function createHostGovernorCoreResolvers(params: {
  state: HostGovernorCoreState;
  assertOpen: () => void;
  sign: (key: string, value: GovernorJsonValue) => string;
}): {
  resolver: GovernorTrustedReceiptResolver;
  evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
} {
  const resolver = Object.freeze({
    resolve: (receiptId: HostGovernorReceiptId, scopeKey: string) => {
      params.assertOpen();
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
  }) satisfies GovernorTrustedReceiptResolver;
  RECEIPT_RESOLVERS.add(resolver);
  const evidenceInvalidationResolver = Object.freeze({
    resolveEvidenceInvalidation: (
      receiptId: HostGovernorEvidenceInvalidationReceiptId,
      scopeKey: string,
    ) => {
      params.assertOpen();
      const receipt = params.state.evidenceInvalidations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return params.sign(params.state.key, body) === signature ? receipt : null;
    },
  }) satisfies GovernorTrustedEvidenceInvalidationResolver;
  EVIDENCE_RESOLVERS.add(evidenceInvalidationResolver);
  return { resolver, evidenceInvalidationResolver };
}
