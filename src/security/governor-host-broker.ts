/**
 * Host-only capability kernel for the experimental behavior governor.
 *
 * This is intentionally not exported by the OpenClaw package.  It is for
 * application bootstrap and authenticated host integrations only: task,
 * model, tool, plugin, and governor modules must never import this module.
 * It does not defend a process/OS compromise that can inspect memory.
 */
import crypto from "node:crypto";
import {
  canonicalGovernorJson,
  governorDigest,
  type GovernorJsonValue,
} from "../tasks/governor/canonical-json.js";
import { createHostApprovalCapabilities } from "./governor-host-approval-capabilities.js";
import type { GovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import type {
  GovernorAuthenticatedApprovalReceipt,
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedReceiptResolver,
  GovernorOwnerIngressClaim,
  HostBrokerState,
  HostGovernorCapabilities,
  HostGovernorOwnerIngressReceiptId,
} from "./governor-host-contracts.js";
import {
  createHostGovernorDeliveryBroker,
  isTrustedGovernorDeliveryResolver,
} from "./governor-host-delivery-broker.js";
import {
  isGovernorHostPersistence,
  type GovernorHostPersistence,
} from "./governor-host-persistence.js";
import type { GovernorTrustedPhysicalExecutionCoordinator } from "./governor-host-physical-execution.js";
import { createHostReceiptCapabilities } from "./governor-host-receipt-capabilities.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";
export type {
  GovernorAuthenticatedApprovalReceipt,
  GovernorAuthenticatedApprovalRevocation,
  GovernorAuthenticatedEvidenceInvalidation,
  GovernorEvidenceInvalidationProvenance,
  GovernorEvidenceInvalidationReason,
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedReceiptResolver,
  GovernorOwnerIngressClaim,
  HostGovernorApprovalReceiptId,
  HostGovernorEvidenceInvalidationReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorOwnerIngressReceiptId,
  HostGovernorOwnerIngressClaimToken,
  HostGovernorReceiptId,
  HostDeliveryReceipt,
} from "./governor-host-contracts.js";

const CAPABILITIES = new WeakSet<object>();
const RESOLVERS = new WeakSet<object>();
const EVIDENCE_INVALIDATION_RESOLVERS = new WeakSet<object>();
const APPROVAL_RESOLVERS = new WeakSet<object>();
const OWNER_INGRESS_RESOLVERS = new WeakSet<object>();
const OWNER_INGRESS_CLAIMS = new WeakSet<object>();
const OWNER_INGRESS_LEASE_MS = 30_000;
function sign(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: GovernorJsonValue): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

/** Internal construction check; a caller-created lookalike resolver is rejected. */
export function isTrustedGovernorReceiptResolver(
  resolver: GovernorTrustedReceiptResolver,
): boolean {
  return RESOLVERS.has(resolver);
}

export function isTrustedGovernorEvidenceInvalidationResolver(
  resolver: GovernorTrustedEvidenceInvalidationResolver,
): boolean {
  return EVIDENCE_INVALIDATION_RESOLVERS.has(resolver);
}

export function isTrustedGovernorApprovalResolver(
  resolver: GovernorTrustedApprovalResolver,
): boolean {
  return APPROVAL_RESOLVERS.has(resolver);
}

export { isTrustedGovernorDeliveryResolver };

export function isTrustedGovernorOwnerIngressResolver(
  resolver: GovernorTrustedOwnerIngressResolver,
): boolean {
  return OWNER_INGRESS_RESOLVERS.has(resolver);
}

/**
 * Called only by application bootstrap after it has resolved host secrets.
 * It deliberately takes a runtime-only key rather than loading any secret in
 * task-facing code.  The returned capabilities are object-capability scoped.
 */
export function createHostGovernorBroker(params: {
  secrets: GovernorSecrets;
  persistence: GovernorHostPersistence;
  deliveryRuntime?: GovernorHostDeliveryRuntime;
}): {
  capabilities: HostGovernorCapabilities;
  resolver: GovernorTrustedReceiptResolver;
  evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
  approvalResolver: GovernorTrustedApprovalResolver;
  deliveryResolver: GovernorTrustedDeliveryResolver;
  ownerIngressResolver: GovernorTrustedOwnerIngressResolver;
  physicalExecutionCoordinator: GovernorTrustedPhysicalExecutionCoordinator;
  memoryAuthority: import("./governor-host-memory-authority.js").GovernorTrustedMemoryAuthority;
  taskAuthority: import("./governor-host-task-authority.js").GovernorTrustedTaskAuthority;
} {
  if (!isGovernorSecrets(params.secrets) || !isGovernorHostPersistence(params.persistence)) {
    throw new Error("Host governor validated secrets and persistence are required");
  }
  const state: HostBrokerState = {
    key: params.secrets.receiptSigningKey,
    receipts: new Map(),
    evidenceInvalidations: new Map(),
    approvals: new Map(),
    revocations: new Map(),
    deliveries: new Map(),
    ownerIngress: new Map(),
  };
  const deliveryBroker = createHostGovernorDeliveryBroker({
    secrets: params.secrets,
    persistence: params.persistence,
    deliveries: state.deliveries,
    deliveryRuntime: params.deliveryRuntime,
  });
  const capability = {};
  CAPABILITIES.add(capability);
  const { submitObservedReceipt, submitEvidenceInvalidation } = createHostReceiptCapabilities({
    state,
    capability,
    isCapability: (value) => CAPABILITIES.has(value),
    sign,
    opaqueId,
  });
  const { submitAuthenticatedApproval, submitApprovalRevocation } = createHostApprovalCapabilities({
    state,
    capability,
    isCapability: (value) => CAPABILITIES.has(value),
    sign,
    opaqueId,
    targetOpaque: (target) => params.secrets.identity.opaqueReference("action-target", target),
    recordGrant: (grant) => params.persistence.recordApprovalGrant(grant),
    revokeGrant: (grant) => params.persistence.revokeApproval(grant),
  });
  const submitAuthenticatedOwnerIngress: HostGovernorCapabilities["submitAuthenticatedOwnerIngress"] =
    (input) => {
      if (!CAPABILITIES.has(capability)) {
        throw new Error("Governor host owner-ingress capability is invalid");
      }
      if (
        (input.channel !== "signal" && input.channel !== "imessage") ||
        !["approve", "enable", "reinvestigate", "repair", "revoke"].includes(input.action) ||
        !Number.isSafeInteger(input.sourceSequence) ||
        input.sourceSequence < 0 ||
        !Number.isSafeInteger(input.observedAt) ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= input.observedAt ||
        input.expiresAt - input.observedAt > 5 * 60_000
      ) {
        throw new Error("Governor owner-ingress envelope is invalid");
      }
      for (const value of [
        input.accountId,
        input.gatewayInstanceId,
        input.ownerPrincipal,
        input.sourceMessageId,
        input.scopeKey,
        input.nonce,
      ]) {
        if (!value.trim()) {
          throw new Error("Governor owner-ingress identity field is required");
        }
      }
      const body = {
        channel: input.channel,
        accountIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-account:${input.channel}`,
          input.accountId,
        ),
        gatewayIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-gateway:${input.channel}`,
          input.gatewayInstanceId,
        ),
        ownerPrincipalIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-principal:${input.channel}`,
          input.ownerPrincipal,
        ),
        sourceMessageIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-message:${input.channel}`,
          input.sourceMessageId,
        ),
        sourceBindingIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-source:${input.channel}`,
          canonicalGovernorJson({
            channel: input.channel,
            accountId: input.accountId,
            gatewayInstanceId: input.gatewayInstanceId,
            ownerPrincipal: input.ownerPrincipal,
            scopeKey: input.scopeKey,
            deploymentIdentity: params.secrets.deploymentIdentity,
          }),
        ),
        sourceSequence: input.sourceSequence,
        action: input.action,
        scopeKey: params.secrets.identity.opaqueReference("owner-ingress-scope", input.scopeKey),
        nonceIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-nonce:${input.channel}`,
          input.nonce,
        ),
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        deploymentIdentity: params.secrets.deploymentIdentity,
      };
      const id = opaqueId(state.key, { ownerIngress: body }) as HostGovernorOwnerIngressReceiptId;
      const receipt = Object.freeze({ id, ...body, signature: sign(state.key, { id, ...body }) });
      params.persistence.storeOwnerIngress(receipt);
      state.ownerIngress.set(id, receipt);
      return id;
    };
  const revokeOwnerIngressReceipt: HostGovernorCapabilities["revokeOwnerIngressReceipt"] = (
    input,
  ) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host owner-ingress capability is invalid");
    }
    const receipt =
      state.ownerIngress.get(input.receiptId) ??
      params.persistence.loadOwnerIngress(input.receiptId);
    if (!receipt) {
      return false;
    }
    const { signature, consumedAt: _consumedAt, ...body } = receipt;
    if (sign(state.key, body) !== signature) {
      throw new Error("Governor owner-ingress receipt signature is invalid");
    }
    const revoked = params.persistence.revokeOwnerIngress({
      receipt,
      revokedAt: input.observedAt,
    });
    if (revoked) {
      state.ownerIngress.delete(input.receiptId);
    }
    return revoked;
  };
  const resolver: GovernorTrustedReceiptResolver = Object.freeze({
    resolve: (receiptId, scopeKey) => {
      const receipt = state.receipts.get(receiptId);
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
      const expected = sign(state.key, { id: receipt.id, ...body });
      return expected === receipt.signature ? receipt : null;
    },
  });
  RESOLVERS.add(resolver);
  const evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver = Object.freeze({
    resolveEvidenceInvalidation: (receiptId, scopeKey) => {
      const receipt = state.evidenceInvalidations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
    },
  });
  EVIDENCE_INVALIDATION_RESOLVERS.add(evidenceInvalidationResolver);
  const approvalReceiptCurrent = (receipt: GovernorAuthenticatedApprovalReceipt): boolean => {
    const { signature, ...body } = receipt;
    return (
      sign(state.key, body) === signature &&
      params.persistence.approvalLedgerMatches({
        grantId: receipt.grantId,
        scopeKey: receipt.scopeKey,
        approvalEpoch: receipt.approvalEpoch,
      })
    );
  };
  const approvalResolver: GovernorTrustedApprovalResolver = Object.freeze({
    resolveApproval: (receiptId, scopeKey) => {
      const receipt = state.approvals.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature &&
        params.persistence.approvalGrantMatches({
          grantId: receipt.grantId,
          scopeKey: receipt.scopeKey,
          approvalEpoch: receipt.approvalEpoch,
        })
        ? receipt
        : null;
    },
    resolveRevocation: (receiptId, scopeKey) => {
      const receipt = state.revocations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
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
        sign(state.key, payload) === grant.authoritySignature &&
        params.persistence.approvalLedgerMatches({
          grantId: grant.grantId,
          scopeKey: grant.scopeKey,
          approvalEpoch: grant.approvalEpoch,
        })
      );
    },
  });
  APPROVAL_RESOLVERS.add(approvalResolver);
  const ownerIngressResolver: GovernorTrustedOwnerIngressResolver = Object.freeze({
    claim: (receiptId, now) => {
      const receipt =
        state.ownerIngress.get(receiptId) ?? params.persistence.loadOwnerIngress(receiptId);
      if (
        !receipt ||
        receipt.consumedAt !== undefined ||
        receipt.expiresAt <= now ||
        receipt.deploymentIdentity !== params.secrets.deploymentIdentity
      ) {
        return null;
      }
      const { signature, consumedAt: _consumedAt, ...body } = receipt;
      if (sign(state.key, body) !== signature) {
        return null;
      }
      const claimToken = opaqueId(state.key, {
        ownerIngressClaim: receipt.id,
        nonce: crypto.randomUUID(),
      }) as import("./governor-host-contracts.js").HostGovernorOwnerIngressClaimToken;
      const claimAttemptIdentity = opaqueId(state.key, {
        ownerIngressAttempt: receipt.id,
        claimToken,
      });
      const leaseExpiresAt = Math.min(receipt.expiresAt, now + OWNER_INGRESS_LEASE_MS);
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
      state.ownerIngress.set(receiptId, receipt);
      const claim: GovernorOwnerIngressClaim = Object.freeze({
        receipt,
        claimToken,
        claimAttemptIdentity,
        leaseExpiresAt,
      });
      OWNER_INGRESS_CLAIMS.add(claim);
      return claim;
    },
    finalize: (claim, taskId, now) => {
      if (!OWNER_INGRESS_CLAIMS.has(claim) || !taskId.trim()) {
        return false;
      }
      const consumed = params.persistence.finalizeOwnerIngress({
        receipt: claim.receipt,
        claimToken: claim.claimToken,
        taskId,
        consumedAt: now,
      });
      if (consumed) {
        state.ownerIngress.set(
          claim.receipt.id,
          Object.freeze({ ...claim.receipt, consumedAt: now }),
        );
      }
      return consumed;
    },
  });
  OWNER_INGRESS_RESOLVERS.add(ownerIngressResolver);
  return {
    capabilities: Object.freeze({
      submitObservedReceipt,
      submitEvidenceInvalidation,
      submitAuthenticatedApproval,
      submitApprovalRevocation,
      registerStaticDeliveryAdapter: deliveryBroker.register,
      revokeDeliveryAdapter: deliveryBroker.revoke,
      resolveUnknownDelivery: deliveryBroker.resolveUnknown,
      submitAuthenticatedOwnerIngress,
      revokeOwnerIngressReceipt,
    }),
    resolver,
    evidenceInvalidationResolver,
    approvalResolver,
    deliveryResolver: deliveryBroker.resolver,
    ownerIngressResolver,
    physicalExecutionCoordinator: params.persistence.physicalExecutions,
    memoryAuthority: params.persistence.memoryAuthority,
    taskAuthority: params.persistence.taskAuthority,
  };
}
